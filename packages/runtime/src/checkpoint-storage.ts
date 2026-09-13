import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { captureGitTree, runSafeGit } from './git-review.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type StoredCheckpointManifest = {
  version: 1;
  id: string;
  createdAt: string;
  objectFormat: 'sha1' | 'sha256';
  baseCommitOid: string;
  snapshotTreeOid: string;
  snapshotCommitOid: string;
  metadata: Record<string, JsonValue>;
  pack: { gitHash: string; bytes: number; sha256: string; indexBytes: number; indexSha256: string };
};

export type CheckpointManifest = StoredCheckpointManifest & { digest: string; directory: string };

const FILE_LIMIT = 64 * 1024 * 1024;
const SNAPSHOT_LIMIT = 512 * 1024 * 1024;
const PACK_LIMIT = 512 * 1024 * 1024;
const METADATA_LIMIT = 1024 * 1024;
const MANIFEST_LIMIT = 2 * 1024 * 1024;
const PATH_LIMIT = 100_000;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;

function gitText(root: string, args: string[], input?: string | Buffer, index?: string): string {
  return runSafeGit(root, args, input, index).toString('utf8').trim();
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute canonical path.`);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch (error) { if (missing(error)) throw new Error(`${label} does not exist.`); throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error(`${label} must be a real directory without symlink traversal.`);
  return path;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}

function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurable(path: string, bytes: string | Buffer): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function hashBytes(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inspectRegularFile(path: string, limit: number, label: string): { bytes: number; sha256: string } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error(`${label} is linked, nonregular, or exceeds the supported limit.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash('sha256');
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size || actual.size > limit) throw new Error(`${label} changed while it was being read.`);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (total < actual.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, actual.size - total), null);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
      total += count;
    }
    const after = fstatSync(fd);
    if (total !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw new Error(`${label} changed while it was being read.`);
    return { bytes: total, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

function readBoundedFile(path: string, limit: number, label: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error(`${label} is linked, nonregular, or exceeds the supported limit.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size || actual.size > limit) throw new Error(`${label} changed while it was being read.`);
    const bytes = Buffer.alloc(actual.size);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (!count) break;
      total += count;
    }
    const after = fstatSync(fd);
    if (total !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw new Error(`${label} changed while it was being read.`);
    return bytes;
  } finally { closeSync(fd); }
}

function normalizeJson(value: unknown, depth: number, arrayItem: boolean, count: { value: number }): JsonValue | undefined {
  if (++count.value > 100_000 || depth > 100) throw new Error('Checkpoint metadata is too deeply nested or contains too many values.');
  if (value === undefined) return arrayItem ? null : undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Checkpoint metadata contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => normalizeJson(item, depth + 1, true, count) ?? null);
  if (typeof value !== 'object') throw new Error('Checkpoint metadata must contain only JSON values.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Checkpoint metadata must contain only plain JSON objects.');
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeJson((value as Record<string, unknown>)[key], depth + 1, false, count);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function normalizeMetadata(metadata: Record<string, unknown>): { value: Record<string, JsonValue>; bytes: Buffer } {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Checkpoint metadata must be a JSON object.');
  const value = normalizeJson(metadata, 0, false, { value: 0 }) as Record<string, JsonValue>;
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > METADATA_LIMIT) throw new Error('Checkpoint metadata exceeds the supported 1 MiB limit.');
  return { value, bytes };
}

function validateSnapshot(root: string, treeOid: string): void {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(runSafeGit(root, ['ls-tree', '-r', '-l', '-z', treeOid]));
  const rows = raw.split('\0').filter(Boolean);
  if (rows.length > PATH_LIMIT) throw new Error('Checkpoint snapshot exceeds the supported 100,000 path limit.');
  let total = 0;
  for (const row of rows) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\s+([0-9]+)\t([^\0]+)$/.exec(row);
    if (!match) throw new Error('Checkpoint snapshots do not support submodules or special Git entries.');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > FILE_LIMIT) throw new Error(`Checkpoint file exceeds the supported 64 MiB limit: ${match[4]}`);
    total += size;
    if (total > SNAPSHOT_LIMIT) throw new Error('Checkpoint snapshot exceeds the supported 512 MiB content limit.');
  }
}

function checkpointBody(manifest: StoredCheckpointManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest) + '\n', 'utf8');
}

function safeGitInit(destination: string, objectFormat: StoredCheckpointManifest['objectFormat']): void {
  const env = safeGitEnvironment();
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', 'init', '--quiet', `--object-format=${objectFormat}`, destination], {
    env,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' });
  return env;
}

function verifyStandalonePack(root: string, packPath: string, indexPath: string, packHash: string, manifest: StoredCheckpointManifest): void {
  const proof = join(dirname(packPath), '.pack-proof');
  runSafeGit(root, ['-c', 'init.templateDir=', 'init', '--quiet', '--bare', `--object-format=${manifest.objectFormat}`, proof]);
  try {
    const proofPack = join(proof, 'objects', 'pack', `pack-${packHash}.pack`);
    const proofIndex = join(proof, 'objects', 'pack', `pack-${packHash}.idx`);
    copyFileSync(packPath, proofPack, constants.COPYFILE_EXCL);
    copyFileSync(indexPath, proofIndex, constants.COPYFILE_EXCL);
    gitText(proof, ['verify-pack', '-s', proofIndex]);
    gitText(proof, ['cat-file', '-e', `${manifest.baseCommitOid}^{commit}`]);
    gitText(proof, ['cat-file', '-e', `${manifest.snapshotTreeOid}^{tree}`]);
    gitText(proof, ['cat-file', '-e', `${manifest.snapshotCommitOid}^{commit}`]);
    gitText(proof, ['fsck', '--connectivity-only', '--no-reflogs', manifest.snapshotCommitOid]);
  } finally { rmSync(proof, { force: true, recursive: true }); }
}

type TreeEntry = { mode: '100644' | '100755' | '120000'; oid: string; path: string; size: number };

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
  if (realpathSync(parent) !== parent) throw new Error('Checkpoint path parent was redirected during restore.');
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
  if (inspectRegularFile(path, FILE_LIMIT, `Restored file ${entry.path}`).bytes !== entry.size) throw new Error('Restored Git blob has an unexpected size.');
}

export function createCheckpoint(workspace: string, evidenceDirectory: string, metadata: Record<string, unknown>): CheckpointManifest {
  const source = canonicalDirectory(workspace, 'Checkpoint workspace');
  const evidence = canonicalDirectory(evidenceDirectory, 'Checkpoint evidence directory');
  if (gitText(source, ['rev-parse', '--show-toplevel']) !== source) throw new Error('Checkpoint workspace must be the root of a Git worktree.');
  const commonDirectory = canonicalDirectory(gitText(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'Git common directory');
  const repositoryRoot = basename(commonDirectory) === '.git' ? dirname(commonDirectory) : commonDirectory;
  if (overlaps(source, evidence) || overlaps(repositoryRoot, evidence)) throw new Error('Checkpoint evidence must be outside the source repository.');
  const normalized = normalizeMetadata(metadata);
  const objectFormat = gitText(source, ['rev-parse', '--show-object-format']);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('Checkpoint repository uses an unsupported Git object format.');
  const baseCommitOid = gitText(source, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!GIT_OID.test(baseCommitOid)) throw new Error('Checkpoint base commit has an unsupported object ID.');
  const id = randomUUID();
  const pending = join(evidence, `.checkpoint-${id}.pending`);
  const directory = join(evidence, `checkpoint-${id}`);
  mkdirSync(pending, { mode: 0o700 });
  let published = false;
  try {
    const snapshotTreeOid = captureGitTree(source, pending);
    validateSnapshot(source, snapshotTreeOid);
    if (captureGitTree(source, pending) !== snapshotTreeOid || gitText(source, ['rev-parse', '--verify', 'HEAD^{commit}']) !== baseCommitOid) throw new Error('Checkpoint workspace changed while it was being captured.');
    const snapshotCommitOid = gitText(source, ['hash-object', '-w', '-t', 'commit', '--stdin'], `tree ${snapshotTreeOid}\nparent ${baseCommitOid}\nauthor Randolph Checkpoint <checkpoint@localhost> 0 +0000\ncommitter Randolph Checkpoint <checkpoint@localhost> 0 +0000\n\nRetained checkpoint ${id}.\n`);
    const prefix = join(pending, 'retained');
    const packHash = gitText(source, ['pack-objects', '--revs', '--index-version=2', prefix], `${snapshotCommitOid}\n`);
    if (!GIT_OID.test(packHash)) throw new Error('Git returned an unsupported checkpoint pack identity.');
    const generatedPack = `${prefix}-${packHash}.pack`;
    const generatedIndex = `${prefix}-${packHash}.idx`;
    const packPath = join(pending, 'objects.pack');
    const indexPath = join(pending, 'objects.idx');
    renameSync(generatedPack, packPath);
    renameSync(generatedIndex, indexPath);
    const pack = inspectRegularFile(packPath, PACK_LIMIT, 'Checkpoint object pack');
    const index = inspectRegularFile(indexPath, MANIFEST_LIMIT * 16, 'Checkpoint object index');
    const stored: StoredCheckpointManifest = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      objectFormat,
      baseCommitOid,
      snapshotTreeOid,
      snapshotCommitOid,
      metadata: normalized.value,
      pack: { gitHash: packHash, bytes: pack.bytes, sha256: pack.sha256, indexBytes: index.bytes, indexSha256: index.sha256 },
    };
    const raw = checkpointBody(stored);
    if (raw.length > MANIFEST_LIMIT) throw new Error('Checkpoint manifest exceeds the supported 2 MiB limit.');
    verifyStandalonePack(source, packPath, indexPath, packHash, stored);
    syncPath(packPath);
    syncPath(indexPath);
    writeDurable(join(pending, 'manifest.json'), raw);
    syncPath(pending);
    if (captureGitTree(source, pending) !== snapshotTreeOid || gitText(source, ['rev-parse', '--verify', 'HEAD^{commit}']) !== baseCommitOid) throw new Error('Checkpoint workspace changed before durable publication.');
    renameSync(pending, directory);
    published = true;
    syncPath(evidence);
    return { ...stored, digest: hashBytes(raw), directory };
  } catch (error) {
    if (workspaceCleanupConfirmed(error)) rmSync(published ? directory : pending, { force: true, recursive: true });
    throw error;
  }
}

function validateManifest(value: unknown): StoredCheckpointManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Checkpoint manifest is corrupt.');
  const manifest = value as StoredCheckpointManifest;
  if (manifest.version !== 1 || !/^[0-9a-f-]{36}$/.test(manifest.id) || Number.isNaN(Date.parse(manifest.createdAt)) || !['sha1', 'sha256'].includes(manifest.objectFormat) ||
    !GIT_OID.test(manifest.baseCommitOid) || !GIT_OID.test(manifest.snapshotTreeOid) || !GIT_OID.test(manifest.snapshotCommitOid) ||
    !manifest.metadata || typeof manifest.metadata !== 'object' || Array.isArray(manifest.metadata) || !manifest.pack || typeof manifest.pack !== 'object' ||
    !GIT_OID.test(manifest.pack.gitHash) || !Number.isSafeInteger(manifest.pack.bytes) || manifest.pack.bytes < 0 || manifest.pack.bytes > PACK_LIMIT || !SHA256.test(manifest.pack.sha256) ||
    !Number.isSafeInteger(manifest.pack.indexBytes) || manifest.pack.indexBytes < 0 || manifest.pack.indexBytes > MANIFEST_LIMIT * 16 || !SHA256.test(manifest.pack.indexSha256)) throw new Error('Checkpoint manifest is corrupt.');
  const normalized = normalizeMetadata(manifest.metadata);
  if (!normalized.bytes.equals(Buffer.from(JSON.stringify(manifest.metadata), 'utf8'))) throw new Error('Checkpoint metadata is not canonical.');
  return manifest;
}

function loadCheckpoint(directory: string, expectedDigest: string): CheckpointManifest {
  const checkpoint = canonicalDirectory(directory, 'Checkpoint directory');
  if (!SHA256.test(expectedDigest)) throw new Error('Expected checkpoint digest is invalid.');
  const raw = readBoundedFile(join(checkpoint, 'manifest.json'), MANIFEST_LIMIT, 'Checkpoint manifest');
  if (hashBytes(raw) !== expectedDigest) throw new Error('Checkpoint manifest digest does not match the selected checkpoint.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Checkpoint manifest is corrupt.'); }
  const stored = validateManifest(parsed);
  if (!checkpointBody(stored).equals(raw)) throw new Error('Checkpoint manifest is not canonical.');
  const pack = inspectRegularFile(join(checkpoint, 'objects.pack'), PACK_LIMIT, 'Checkpoint object pack');
  const index = inspectRegularFile(join(checkpoint, 'objects.idx'), MANIFEST_LIMIT * 16, 'Checkpoint object index');
  if (pack.bytes !== stored.pack.bytes || pack.sha256 !== stored.pack.sha256 || index.bytes !== stored.pack.indexBytes || index.sha256 !== stored.pack.indexSha256) throw new Error('Checkpoint object storage is corrupt.');
  return { ...stored, digest: expectedDigest, directory: checkpoint };
}

export function readCheckpoint(directory: string, expectedDigest: string): CheckpointManifest {
  return loadCheckpoint(directory, expectedDigest);
}

function assertOwnedDirectory(path: string, identity: Stats): void {
  const current = lstatSync(path);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Restore destination was replaced while files were being written.');
}

export function restoreCheckpoint(directory: string, expectedDigest: string, destination: string): { workspace: string; manifest: CheckpointManifest } {
  const manifest = readCheckpoint(directory, expectedDigest);
  if (!isAbsolute(destination) || resolve(destination) !== destination) throw new Error('Restore destination must be an absolute canonical path.');
  const parent = canonicalDirectory(dirname(destination), 'Restore destination parent');
  if (exists(destination)) throw new Error('Restore destination must be a new directory. Existing files are never overwritten.');
  if (overlaps(manifest.directory, destination)) throw new Error('Restore destination must be outside the checkpoint directory.');
  if (realpathSync(parent) !== parent) throw new Error('Restore destination parent was redirected.');
  mkdirSync(destination, { mode: 0o700 });
  const identity = statSync(destination) as Stats;
  try {
    safeGitInit(destination, manifest.objectFormat);
    assertOwnedDirectory(destination, identity);
    const packDirectory = join(destination, '.git', 'objects', 'pack');
    const restoredPack = join(packDirectory, `pack-${manifest.pack.gitHash}.pack`);
    const restoredIndex = join(packDirectory, `pack-${manifest.pack.gitHash}.idx`);
    copyFileSync(join(manifest.directory, 'objects.pack'), restoredPack, constants.COPYFILE_EXCL);
    copyFileSync(join(manifest.directory, 'objects.idx'), restoredIndex, constants.COPYFILE_EXCL);
    if (inspectRegularFile(restoredPack, PACK_LIMIT, 'Restored object pack').sha256 !== manifest.pack.sha256 || inspectRegularFile(restoredIndex, MANIFEST_LIMIT * 16, 'Restored object index').sha256 !== manifest.pack.indexSha256) throw new Error('Restored checkpoint objects do not match retained storage.');
    gitText(destination, ['verify-pack', '-s', restoredIndex]);
    gitText(destination, ['cat-file', '-e', `${manifest.baseCommitOid}^{commit}`]);
    gitText(destination, ['cat-file', '-e', `${manifest.snapshotTreeOid}^{tree}`]);
    gitText(destination, ['fsck', '--connectivity-only', '--no-reflogs', manifest.snapshotCommitOid]);
    runSafeGit(destination, ['read-tree', manifest.baseCommitOid]);
    gitText(destination, ['update-ref', '--no-deref', 'HEAD', manifest.baseCommitOid]);
    assertOwnedDirectory(destination, identity);
    for (const entry of treeEntries(destination, manifest.snapshotTreeOid).sort((left, right) => Number(left.mode === '120000') - Number(right.mode === '120000'))) materializeBlob(destination, entry);
    assertOwnedDirectory(destination, identity);
    const gitDirectory = canonicalDirectory(join(destination, '.git'), 'Restored Git directory');
    let attached = false;
    try { gitText(destination, ['symbolic-ref', '-q', 'HEAD']); attached = true; } catch (error) { if (!workspaceCleanupConfirmed(error)) throw error; /* Detached HEAD is required. */ }
    if (captureGitTree(destination, gitDirectory) !== manifest.snapshotTreeOid || captureGitTree(destination, gitDirectory) !== manifest.snapshotTreeOid || gitText(destination, ['rev-parse', '--verify', 'HEAD^{commit}']) !== manifest.baseCommitOid || attached) throw new Error('Restored checkpoint content or base identity does not match the manifest.');
    return { workspace: destination, manifest };
  } catch (error) {
    try { if (workspaceCleanupConfirmed(error)) { assertOwnedDirectory(destination, identity); rmSync(destination, { force: true, recursive: true }); } } catch { /* Preserve a replaced destination rather than deleting an unknown path. */ }
    throw error;
  }
}
