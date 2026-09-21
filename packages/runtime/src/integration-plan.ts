import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { runSafeGit } from './git-execution.js';
import {
  assertCleanGitParent,
  captureGitTree,
  inspectGitWorkspace,
} from './git-workspace-snapshot.js';
import type { Entry, GitIntegrationPlan, RetainedEntry } from './integration-contracts.js';
import {
  assertDetached,
  assertIdentity,
  digest,
  FILE_LIMIT,
  gitText,
  preflightPaths,
  readIndex,
} from './integration-evidence.js';

const TOTAL_LIMIT = 64 * 1024 * 1024;

function treeEntries(root: string, tree: string): Map<string, Entry> {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(
    runSafeGit(root, ['ls-tree', '-r', '-z', tree]),
  );
  const entries = new Map<string, Entry>();
  for (const row of source.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Integration does not support submodules or special Git entries.');
    const path = match[3];
    if (path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.git'))
      throw new Error('Unsupported integration path.');
    entries.set(path, { mode: match[1] as Entry['mode'], oid: match[2] });
  }
  return entries;
}
function sameEntry(left?: Entry | null, right?: Entry | null): boolean {
  return left?.mode === right?.mode && left?.oid === right?.oid;
}
export function prepareIntegration(
  root: string,
  workspace: string,
  evidenceDir: string,
): GitIntegrationPlan {
  const basis = inspectGitWorkspace(root, workspace);
  assertDetached(workspace);
  assertCleanGitParent(root, workspace);
  if (
    realpathSync(evidenceDir) !== resolve(evidenceDir) ||
    !lstatSync(evidenceDir).isDirectory() ||
    resolve(evidenceDir).startsWith(root + sep) ||
    resolve(evidenceDir) === root
  )
    throw new Error('Integration evidence must be a canonical directory outside the project.');
  const keys = gitText(workspace, ['config', '--null', '--name-only', '--list']).split('\0');
  if (keys.some((key) => /^merge\..*\.driver$/.test(key)))
    throw new Error('Custom Git merge drivers require manual integration; no driver was executed.');
  try {
    gitText(workspace, ['merge-base', basis.workspaceHead, basis.parentOid]);
  } catch {
    throw new Error('The parent and conversation histories are unrelated; integrate manually.');
  }
  const sourceTreeOid = captureGitTree(workspace, evidenceDir);
  if (captureGitTree(workspace, evidenceDir) !== sourceTreeOid)
    throw new Error('Worktree changed while preparing integration.');
  let targetTreeOid = sourceTreeOid;
  let conflicts: string[] = [];
  let messages = '';
  if (basis.workspaceHead !== basis.parentOid) {
    const originalCommit = gitText(workspace, ['cat-file', 'commit', basis.workspaceHead]);
    const author = /^author (.+)$/m.exec(originalCommit)?.[1];
    const committer = /^committer (.+)$/m.exec(originalCommit)?.[1];
    if (!author || !committer)
      throw new Error('The conversation base commit has invalid metadata.');
    const snapshot = gitText(
      workspace,
      ['hash-object', '-w', '-t', 'commit', '--stdin'],
      `tree ${sourceTreeOid}\nparent ${basis.workspaceHead}\nauthor ${author}\ncommitter ${committer}\n\nUnreferenced integration snapshot.\n`,
    );
    const merged = runSafeGit(
      workspace,
      ['merge-tree', '--write-tree', '--stdin', '--name-only', '-z'],
      `${snapshot} ${basis.parentOid}\n`,
    )
      .toString('utf8')
      .split('\0');
    if (!['0', '1'].includes(merged[0]) || !/^[0-9a-f]{40,64}$/.test(merged[1] ?? ''))
      throw new Error('Git returned an unsupported integration result.');
    targetTreeOid = merged[1];
    const end = merged.indexOf('', 2);
    if (end < 0) throw new Error('Git returned incomplete integration evidence.');
    conflicts = merged.slice(2, end);
    messages = merged
      .slice(end + 1)
      .filter(Boolean)
      .join('\n');
    if (merged[0] === '0' && !conflicts.length)
      throw new Error('Git reported a conflict without actionable paths.');
  }
  const id = randomUUID();
  const retained = join(evidenceDir, `integration-${id}`);
  mkdirSync(retained, { mode: 0o700 });
  mkdirSync(join(retained, 'blobs'), { mode: 0o700 });
  const before = treeEntries(workspace, sourceTreeOid);
  const after = treeEntries(workspace, targetTreeOid);
  let total = 0;
  const retain = (entry?: Entry): RetainedEntry | null => {
    if (!entry) return null;
    const blobPath = join(retained, 'blobs', entry.oid);
    if (!existsSync(blobPath)) {
      const size = Number(gitText(workspace, ['cat-file', '-s', entry.oid]));
      if (!Number.isSafeInteger(size) || size > FILE_LIMIT || total + size > TOTAL_LIMIT)
        throw new Error(
          'Integration changes exceed the supported 8 MiB per-file or 64 MiB retained-content limit. No worktree files changed.',
        );
      const bytes = runSafeGit(workspace, ['cat-file', 'blob', entry.oid]);
      total += bytes.length;
      writeFileSync(blobPath, bytes, { flag: 'wx', mode: 0o600 });
    }
    return { ...entry, blobPath };
  };
  const files = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((path) => !sameEntry(before.get(path), after.get(path)))
    .map((path) => ({ path, before: retain(before.get(path)), after: retain(after.get(path)) }));
  preflightPaths(workspace, files);
  const indexPath = gitText(workspace, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'index',
  ]);
  const originalIndex = readIndex(indexPath);
  const originalIndexPath = join(retained, 'original-index');
  writeFileSync(originalIndexPath, originalIndex, { flag: 'wx', mode: 0o600 });
  const targetIndexPath = join(retained, 'target-index');
  runSafeGit(
    workspace,
    ['-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', 'read-tree', targetTreeOid],
    undefined,
    targetIndexPath,
  );
  const plan: GitIntegrationPlan = {
    id,
    basis,
    sourceTreeOid,
    targetTreeOid,
    conflicts,
    messages: messages.slice(0, 65_536),
    truncated: messages.length > 65_536,
    evidenceDir: retained,
    files,
    indexPath,
    originalIndexPath,
    originalIndexHash: digest(originalIndex),
    targetIndexPath,
    targetIndexHash: digest(readIndex(targetIndexPath)),
  };
  assertIdentity(inspectGitWorkspace(root, workspace), basis);
  if (
    captureGitTree(workspace, retained) !== sourceTreeOid ||
    digest(readIndex(indexPath)) !== plan.originalIndexHash
  )
    throw new Error('Worktree or staging changed while preparing integration.');
  return plan;
}
