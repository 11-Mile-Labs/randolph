import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  assertCleanGitParent,
  captureGitTree,
  inspectGitWorkspace,
  runSafeGit,
  type GitDeliveryPlan,
  type GitWorkspace,
} from './git-review.js';

type Entry = { mode: '100644' | '100755' | '120000'; oid: string };
type RetainedEntry = Entry & { blobPath: string };
export type GitIntegrationFile = {
  path: string;
  before: RetainedEntry | null;
  after: RetainedEntry | null;
};
export type GitIntegrationPlan = {
  id: string;
  basis: GitWorkspace;
  sourceTreeOid: string;
  targetTreeOid: string;
  conflicts: string[];
  messages: string;
  truncated: boolean;
  evidenceDir: string;
  files: GitIntegrationFile[];
  indexPath: string;
  originalIndexPath: string;
  originalIndexHash: string;
  targetIndexPath: string;
  targetIndexHash: string;
};
export type GitIntegrationResult = {
  status: 'unchanged' | 'integrated' | 'conflicted';
  parentOid: string;
  treeOid: string;
  conflicts: string[];
  evidenceDir: string;
};
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const gitText = (root: string, args: string[], input?: string | Buffer, index?: string): string =>
  runSafeGit(root, args, input, index).toString('utf8').trim();
const FILE_LIMIT = 8 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;

function assertIdentity(actual: GitWorkspace, expected: GitWorkspace, allowHead?: string): void {
  for (const key of [
    'root',
    'workspace',
    'parentBranch',
    'parentOid',
    'commonDir',
    'rootIdentity',
    'workspaceIdentity',
    'commonDirIdentity',
  ] as const) {
    if (actual[key] !== expected[key])
      throw new Error(
        'Integration is stale: project identity or target branch changed. Prepare integration again.',
      );
  }
  if (actual.workspaceHead !== expected.workspaceHead && actual.workspaceHead !== allowHead)
    throw new Error('Integration is stale: the conversation HEAD changed.');
}
function assertDetached(workspace: string): void {
  if (gitText(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'HEAD')
    throw new Error('Integration requires a detached app-managed worktree; no branch was changed.');
}
function readIndex(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error('Git index is missing or redirected.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
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
function pathState(workspace: string, name: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(join(workspace, name));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      return undefined;
    throw error;
  }
}
function preflightPaths(workspace: string, files: GitIntegrationFile[]): void {
  for (const file of files) {
    const current = pathState(workspace, file.path);
    if (current?.isDirectory())
      throw new Error(`Directory-to-file integration requires manual resolution: ${file.path}`);
    if (!file.before && current)
      throw new Error(`Integration would overwrite an ignored or unrelated file: ${file.path}`);
    let parent = dirname(join(workspace, file.path));
    while (parent !== workspace) {
      if (!parent.startsWith(workspace + sep))
        throw new Error('Integration path left its worktree.');
      try {
        if (!lstatSync(parent).isDirectory())
          throw new Error(`Integration path is blocked or redirected: ${file.path}`);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
        )
          throw error;
      }
      parent = dirname(parent);
    }
  }
}
function result(plan: GitIntegrationPlan): GitIntegrationResult {
  return {
    status:
      plan.basis.workspaceHead === plan.basis.parentOid
        ? 'unchanged'
        : plan.conflicts.length
          ? 'conflicted'
          : 'integrated',
    parentOid: plan.basis.parentOid,
    treeOid: plan.targetTreeOid,
    conflicts: plan.conflicts,
    evidenceDir: plan.evidenceDir,
  };
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
function readRetained(entry: RetainedEntry, evidenceDir: string): Buffer {
  if (
    !/^[0-9a-f]{40,64}$/.test(entry.oid) ||
    entry.blobPath !== join(evidenceDir, 'blobs', entry.oid) ||
    realpathSync(dirname(entry.blobPath)) !== dirname(entry.blobPath)
  )
    throw new Error('Retained integration content was redirected.');
  const bytes = readBoundedFile(entry.blobPath);
  const oid = createHash(entry.oid.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  if (oid !== entry.oid) throw new Error('Retained integration content changed.');
  return bytes;
}
function readBoundedFile(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.size > FILE_LIMIT)
    throw new Error('Integration content is linked, nonregular, or oversized.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd);
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.size > FILE_LIMIT
    )
      throw new Error('Integration content changed while being read.');
    const bytes = Buffer.alloc(Math.min(FILE_LIMIT + 1, actual.size + 1));
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== actual.size || fstatSync(fd).size !== actual.size)
      throw new Error('Integration content changed while being read.');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
function matchesFile(
  workspace: string,
  file: GitIntegrationFile,
  entry: RetainedEntry | null,
  evidenceDir: string,
): boolean {
  try {
    const state = pathState(workspace, file.path);
    if (!state) return entry === null;
    if (
      !entry ||
      realpathSync(dirname(join(workspace, file.path))) !== dirname(join(workspace, file.path))
    )
      return false;
    const mode = state.isSymbolicLink()
      ? '120000'
      : state.isFile()
        ? Number(state.mode) & 0o111
          ? '100755'
          : '100644'
        : '';
    if (mode !== entry.mode) return false;
    const bytes = state.isSymbolicLink()
      ? readlinkSync(join(workspace, file.path), { encoding: 'buffer' })
      : readBoundedFile(join(workspace, file.path));
    return bytes.equals(readRetained(entry, evidenceDir));
  } catch {
    return false;
  }
}
function replaceFiles(
  workspace: string,
  files: GitIntegrationFile[],
  side: 'before' | 'after',
  evidenceDir: string,
  touched?: Map<string, RetainedEntry | null>,
): void {
  for (const file of [...files].sort((a, b) => b.path.length - a.path.length)) {
    const state = pathState(workspace, file.path);
    if (state?.isDirectory()) throw new Error(`Integration directory changed: ${file.path}`);
    if (state) {
      unlinkSync(join(workspace, file.path));
      touched?.set(file.path, null);
    }
  }
  for (const file of files) {
    const entry = file[side];
    if (!entry) continue;
    const path = join(workspace, file.path);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = readRetained(entry, evidenceDir);
    if (entry.mode === '120000') symlinkSync(bytes, path);
    else writeFileSync(path, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    touched?.set(file.path, entry);
  }
}
export function applyIntegration(
  root: string,
  workspace: string,
  plan: GitIntegrationPlan,
): GitIntegrationResult {
  const actual = inspectGitWorkspace(root, workspace);
  assertIdentity(actual, plan.basis, plan.basis.parentOid);
  assertDetached(workspace);
  assertCleanGitParent(root, workspace);
  if (
    plan.basis.root !== root ||
    plan.basis.workspace !== workspace ||
    gitText(workspace, ['rev-parse', '--path-format=absolute', '--git-path', 'index']) !==
      plan.indexPath
  )
    throw new Error('Integration plan belongs to a different worktree.');
  const currentTree = captureGitTree(workspace, plan.evidenceDir);
  const currentIndex = digest(readIndex(plan.indexPath));
  if (
    actual.workspaceHead === plan.basis.parentOid &&
    currentTree === plan.targetTreeOid &&
    currentIndex === plan.targetIndexHash
  )
    return result(plan);
  if (
    actual.workspaceHead !== plan.basis.workspaceHead ||
    currentTree !== plan.sourceTreeOid ||
    currentIndex !== plan.originalIndexHash
  )
    throw new Error(
      `Integration is stale or partially applied. Original content is retained at ${plan.evidenceDir}; inspect it before continuing.`,
    );
  if (plan.basis.workspaceHead === plan.basis.parentOid) return result(plan);
  preflightPaths(workspace, plan.files);
  const originalIndex = readIndex(plan.originalIndexPath);
  const targetIndex = readIndex(plan.targetIndexPath);
  if (
    digest(originalIndex) !== plan.originalIndexHash ||
    digest(targetIndex) !== plan.targetIndexHash
  )
    throw new Error('Retained integration index evidence changed.');
  for (const file of plan.files)
    for (const entry of [file.before, file.after]) if (entry) readRetained(entry, plan.evidenceDir);
  const lock = `${plan.indexPath}.lock`;
  const fd = openSync(
    lock,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let lockOwned = true;
  let movedHead = false;
  const touched = new Map<string, RetainedEntry | null>();
  try {
    writeFileSync(fd, targetIndex);
    fsyncSync(fd);
    assertIdentity(inspectGitWorkspace(root, workspace), plan.basis);
    assertDetached(workspace);
    if (captureGitTree(workspace, plan.evidenceDir) !== plan.sourceTreeOid)
      throw new Error('Worktree changed before integration could apply.');
    replaceFiles(workspace, plan.files, 'after', plan.evidenceDir, touched);
    assertIdentity(inspectGitWorkspace(root, workspace), plan.basis);
    assertDetached(workspace);
    runSafeGit(workspace, [
      'update-ref',
      '--no-deref',
      'HEAD',
      plan.basis.parentOid,
      plan.basis.workspaceHead,
    ]);
    movedHead = true;
    closeSync(fd);
    renameSync(lock, plan.indexPath);
    lockOwned = false;
    if (captureGitTree(workspace, plan.evidenceDir) !== plan.targetTreeOid)
      throw new Error('Applied integration content could not be verified.');
    return result(plan);
  } catch (error) {
    try {
      if (movedHead) {
        assertDetached(workspace);
        runSafeGit(workspace, [
          'update-ref',
          '--no-deref',
          'HEAD',
          plan.basis.workspaceHead,
          plan.basis.parentOid,
        ]);
      }
      let incomplete = false;
      for (const file of plan.files.filter((item) => touched.has(item.path))) {
        if (matchesFile(workspace, file, file.before, plan.evidenceDir)) continue;
        if (!matchesFile(workspace, file, touched.get(file.path) ?? null, plan.evidenceDir)) {
          incomplete = true;
          continue;
        }
        try {
          replaceFiles(workspace, [file], 'before', plan.evidenceDir);
        } catch {
          incomplete = true;
        }
      }
      if (incomplete) throw new Error('Unexpected worktree edits were preserved during rollback.');
      if (!lockOwned) {
        writeFileSync(lock, originalIndex, { flag: 'wx', mode: 0o600 });
        renameSync(lock, plan.indexPath);
      }
    } catch {
      throw new Error(
        `Integration stopped with an incomplete rollback. Original file and index evidence is retained at ${plan.evidenceDir}; manual reconciliation is required.`,
      );
    }
    throw error;
  } finally {
    if (lockOwned) {
      try {
        closeSync(fd);
      } catch {
        /* Descriptor already closed before a failed rename. */
      }
      unlinkSync(lock);
    }
  }
}
export function reconcileSupersededDelivery(
  root: string,
  workspace: string,
  plan: GitDeliveryPlan,
): { commitCreated: boolean; merged: boolean } {
  const actual = inspectGitWorkspace(root, workspace);
  assertIdentity(
    { ...actual, parentOid: plan.review.parentOid, workspaceHead: plan.review.workspaceHead },
    plan.review,
  );
  if (
    gitText(root, ['hash-object', '-t', 'commit', '--stdin'], plan.commitContent) !==
      plan.commitOid ||
    !plan.commitContent.startsWith(`tree ${plan.review.treeOid}\nparent ${plan.review.parentOid}\n`)
  )
    throw new Error('Invalid original delivery plan.');
  let commitCreated = false;
  let merged = false;
  try {
    commitCreated =
      gitText(root, ['cat-file', 'commit', plan.commitOid]) === plan.commitContent.trim();
  } catch {
    /* No completed commit object. */
  }
  if (commitCreated) {
    try {
      runSafeGit(root, ['merge-base', '--is-ancestor', plan.commitOid, actual.parentOid]);
      merged = true;
    } catch {
      /* Original approval was not merged. */
    }
  }
  return { commitCreated, merged };
}
