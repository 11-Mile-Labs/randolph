import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { runSafeGit } from './git-execution.js';
import {
  assertCleanGitParent,
  captureGitTree,
  inspectGitWorkspace,
} from './git-workspace-snapshot.js';
import type {
  GitIntegrationFile,
  GitIntegrationPlan,
  GitIntegrationResult,
  RetainedEntry,
} from './integration-contracts.js';
import {
  assertDetached,
  assertIdentity,
  digest,
  FILE_LIMIT,
  gitText,
  pathState,
  preflightPaths,
  readIndex,
} from './integration-evidence.js';

// Retained-content verification, file replacement, the index lock, the touched-file map and the
// rollback loop all stay in this module, and applyIntegration keeps its try/catch/finally in one
// function: lock ownership and rollback must remain visible together, never handed to an external
// callback.
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
