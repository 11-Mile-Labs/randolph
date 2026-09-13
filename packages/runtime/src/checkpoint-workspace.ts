import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readCheckpoint, type CheckpointManifest } from './checkpoint-storage.js';
import { captureGitTree, runSafeGit } from './git-review.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_LIMIT = 64 * 1024 * 1024;
const INDEX_LIMIT = 32 * 1024 * 1024;
type TreeEntry = { mode: '100644' | '100755' | '120000'; oid: string; path: string; size: number };

function gitText(root: string, args: string[], input?: string | Buffer, index?: string): string {
  return runSafeGit(root, args, input, index).toString('utf8').trim();
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' });
  return env;
}

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute canonical path.`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error(`${label} was redirected or is not a real directory.`);
  return path;
}

function ensureWorktreeDirectory(root: string): string {
  const path = join(root, '.worktrees');
  if (!exists(path)) mkdirSync(path, { mode: 0o700 });
  return canonicalDirectory(path, 'Project worktree directory');
}

function directoryIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project or worktree identity changed.');
  return `${stat.dev}:${stat.ino}`;
}

function inspectFile(path: string, limit: number, label: string): { bytes: number; sha256: string } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error(`${label} is linked, nonregular, or oversized.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash('sha256');
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) throw new Error(`${label} changed while it was being read.`);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (total < actual.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, actual.size - total), null);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
      total += count;
    }
    if (total !== actual.size || fstatSync(fd).size !== actual.size) throw new Error(`${label} changed while it was being read.`);
    return { bytes: total, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

function copyObject(source: string, destination: string, expectedBytes: number, expectedDigest: string, limit: number): boolean {
  if (exists(destination)) {
    const current = inspectFile(destination, limit, 'Existing checkpoint object');
    if (current.bytes !== expectedBytes || current.sha256 !== expectedDigest) throw new Error('A conflicting Git object pack already exists in this project. Restore files to a new folder first.');
    return false;
  }
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  const copied = inspectFile(destination, limit, 'Imported checkpoint object');
  if (copied.bytes !== expectedBytes || copied.sha256 !== expectedDigest) {
    rmSync(destination, { force: true });
    throw new Error('Imported checkpoint objects did not match retained storage.');
  }
  const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

export function importCheckpointObjects(projectRoot: string, commonDirectory: string, manifest: CheckpointManifest): void {
  const packDirectory = canonicalDirectory(join(commonDirectory, 'objects', 'pack'), 'Git object pack directory');
  const pack = join(packDirectory, `pack-${manifest.pack.gitHash}.pack`);
  const index = join(packDirectory, `pack-${manifest.pack.gitHash}.idx`);
  const created: string[] = [];
  try {
    if (copyObject(join(manifest.directory, 'objects.pack'), pack, manifest.pack.bytes, manifest.pack.sha256, FILE_LIMIT * 8)) created.push(pack);
    if (copyObject(join(manifest.directory, 'objects.idx'), index, manifest.pack.indexBytes, manifest.pack.indexSha256, INDEX_LIMIT)) created.push(index);
    gitText(projectRoot, ['verify-pack', '-s', index]);
    const fd = openSync(packDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if (workspaceCleanupConfirmed(error)) for (const path of created) rmSync(path, { force: true });
    throw error;
  }
}

function treeEntries(root: string, treeOid: string): TreeEntry[] {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(runSafeGit(root, ['ls-tree', '-r', '-l', '-z', treeOid]));
  return raw.split('\0').filter(Boolean).map(row => {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\s+([0-9]+)\t([^\0]+)$/.exec(row);
    if (!match) throw new Error('Checkpoint contains a submodule or unsupported Git entry.');
    const path = match[4];
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Checkpoint contains an unsafe Git path.');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT || (match[1] === '120000' && size > 4096)) throw new Error('Checkpoint contains an oversized Git object.');
    return { mode: match[1] as TreeEntry['mode'], oid: match[2], path, size };
  });
}

function materializeBlob(root: string, entry: TreeEntry): void {
  const path = join(root, entry.path);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== parent) throw new Error('Checkpoint path parent was redirected during linked restore.');
  if (entry.mode === '120000') {
    const target = runSafeGit(root, ['cat-file', 'blob', entry.oid]);
    if (target.length !== entry.size || target.includes(0)) throw new Error('Checkpoint symlink target is invalid.');
    symlinkSync(target, path);
    return;
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, entry.mode === '100755' ? 0o755 : 0o644);
  try {
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-C', root, 'cat-file', 'blob', entry.oid], {
      env: safeGitEnvironment(),
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', fd, 'pipe'],
      timeout: 30_000,
    });
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (inspectFile(path, FILE_LIMIT, `Restored file ${entry.path}`).bytes !== entry.size) throw new Error('Restored Git blob has an unexpected size.');
}

function restoreLimitation(message: string): Error {
  return new Error(`${message} Restore files to a new folder first; linked execution requires the original related project.`);
}

export function restoreCheckpointWorktree(directory: string, expectedDigest: string, projectRoot: string, workspaceId: string): { workspace: string; manifest: CheckpointManifest } {
  const manifest = readCheckpoint(directory, expectedDigest);
  if (!UUID.test(workspaceId)) throw new Error('Linked checkpoint workspace ID must be a UUID.');
  let root: string;
  try { root = canonicalDirectory(projectRoot, 'Original project'); }
  catch { throw restoreLimitation('The original project is missing or redirected.'); }
  if (gitText(root, ['rev-parse', '--show-toplevel']) !== root) throw restoreLimitation('The original project is no longer a Git repository.');
  const worktrees = ensureWorktreeDirectory(root);
  const workspace = join(worktrees, `randolph-${workspaceId}`);
  if (exists(workspace)) throw new Error('Linked checkpoint destination already exists; existing work is never overwritten.');
  const registered = runSafeGit(root, ['worktree', 'list', '--porcelain', '-z']).toString('utf8').split('\0').some(row => row === `worktree ${workspace}`);
  if (registered) throw new Error('Linked checkpoint destination is already registered; reconcile it before retrying.');
  let parentBranch: string;
  try { parentBranch = gitText(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']); }
  catch (error) { if (!workspaceCleanupConfirmed(error)) throw error; throw restoreLimitation('The original project parent branch is detached.'); }
  const parentOid = gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const commonDirectory = canonicalDirectory(gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'Git common directory');
  const rootIdentity = directoryIdentity(root);
  const commonIdentity = directoryIdentity(commonDirectory);
  if (gitText(root, ['rev-parse', '--show-object-format']) !== manifest.objectFormat) throw restoreLimitation('The original project uses a different Git object format.');
  importCheckpointObjects(root, commonDirectory, manifest);
  try { runSafeGit(root, ['merge-base', '--is-ancestor', manifest.baseCommitOid, parentOid]); }
  catch (error) { if (!workspaceCleanupConfirmed(error)) throw error; throw restoreLimitation('The checkpoint base is not an ancestor of the current parent branch.'); }
  let created = false;
  let workspaceIdentity = '';
  try {
    runSafeGit(root, ['worktree', 'add', '--detach', '--no-checkout', workspace, manifest.baseCommitOid]);
    created = true;
    workspaceIdentity = directoryIdentity(canonicalDirectory(workspace, 'Linked checkpoint worktree'));
    runSafeGit(workspace, ['-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', 'read-tree', manifest.baseCommitOid]);
    for (const entry of treeEntries(workspace, manifest.snapshotTreeOid).sort((left, right) => Number(left.mode === '120000') - Number(right.mode === '120000'))) materializeBlob(workspace, entry);
    if (directoryIdentity(workspace) !== workspaceIdentity || directoryIdentity(root) !== rootIdentity || directoryIdentity(commonDirectory) !== commonIdentity || gitText(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== parentBranch || gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']) !== parentOid) throw new Error('Project identity or parent branch changed during linked checkpoint restore.');
    const gitDirectory = canonicalDirectory(gitText(workspace, ['rev-parse', '--path-format=absolute', '--git-dir']), 'Linked worktree Git directory');
    if (captureGitTree(workspace, gitDirectory) !== manifest.snapshotTreeOid || captureGitTree(workspace, gitDirectory) !== manifest.snapshotTreeOid || gitText(workspace, ['rev-parse', '--verify', 'HEAD^{commit}']) !== manifest.baseCommitOid) throw new Error('Linked checkpoint worktree does not match the retained snapshot.');
    return { workspace, manifest };
  } catch (error) {
    if (created && workspaceCleanupConfirmed(error)) {
      try {
        if (directoryIdentity(workspace) === workspaceIdentity && directoryIdentity(root) === rootIdentity && directoryIdentity(commonDirectory) === commonIdentity) runSafeGit(root, ['worktree', 'remove', '--force', workspace]);
      } catch (cleanupError) { if (!workspaceCleanupConfirmed(cleanupError)) throw new Error("Linked restore cleanup could not be confirmed.", { cause: cleanupError }); /* Preserve unknown replacement paths. */ }
    }
    throw error;
  }
}
