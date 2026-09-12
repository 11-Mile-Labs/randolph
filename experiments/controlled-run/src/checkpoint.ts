import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, posix } from 'node:path';
import { git } from './fixture.js';
import { cleanEnvironment } from './codex.js';
import type { Journal } from './evidence.js';

export type CheckpointEntry = { path: string; kind: 'file' | 'symlink'; mode: number; digest?: string; size?: number; target?: string };
export type CheckpointManifest = { version: 1; baseRef: string; baseOid: string; bundleDigest: string; entries: CheckpointEntry[]; deleted: string[]; metadata: Record<string, unknown>; manifestDigest: string };
export type CheckpointInput = { worktree: string; checkpointDir: string; baseRef: string; metadata: Record<string, unknown>; journal: Journal; fault?: 'after-contents' | 'before-manifest' | 'after-manifest' };

const digest = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
function statOrMissing(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) { if (missing(error)) return; throw error; }
}
function realDirectories(path: string): void {
  if (!isAbsolute(path)) throw new Error('Absolute path required');
  let current = '/';
  for (const part of resolve(path).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = statOrMissing(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Path parent must be a real directory');
  }
}
function validPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || posix.normalize(path) !== path ||
    path.split('/').some(part => ['..', '.', '.git', '.worktrees'].includes(part))) throw new Error('Unsafe checkpoint path');
}
function regularBytes(path: string): Buffer {
  realDirectories(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Checkpoint content must be a regular unlinked file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durable(path: string, bytes: Buffer | string): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  syncPath(path);
}
function gitNames(worktree: string, args: string[]): string[] {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: worktree, env: cleanEnvironment(process.env), timeout: 10_000, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}
function inventory(worktree: string, save?: (hash: string, bytes: Buffer) => void): CheckpointEntry[] {
  const entries: CheckpointEntry[] = [];
  const names = [...new Set(gitNames(worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))].sort();
  for (const path of names) {
    validPath(path);
    const absolute = join(worktree, path);
    realDirectories(dirname(absolute));
    const stat = statOrMissing(absolute);
    if (!stat) continue;
    if (stat.isSymbolicLink()) entries.push({ path, kind: 'symlink', mode: 0o777, target: readlinkSync(absolute) });
    else if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error('Multiply linked source files are unsupported');
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { bytes = readFileSync(fd); } finally { closeSync(fd); }
      const hash = digest(bytes);
      save?.(hash, bytes);
      entries.push({ path, kind: 'file', mode: stat.mode & 0o777, digest: hash, size: bytes.length });
    } else throw new Error('Unsupported checkpoint entry type');
  }
  return entries;
}

export async function captureCheckpoint(input: CheckpointInput): Promise<CheckpointManifest> {
  if (!isAbsolute(input.worktree) || !isAbsolute(input.checkpointDir)) throw new Error('Absolute checkpoint paths required');
  const root = resolve(input.worktree);
  const dir = resolve(input.checkpointDir);
  realDirectories(root);
  realDirectories(dirname(dir));
  if (statOrMissing(dir) || !relative(root, dir).startsWith('..') || !relative(dir, root).startsWith('..')) throw new Error('Checkpoint must be a new directory outside source');
  const baseOid = git(root, ['rev-parse', '--verify', input.baseRef + '^{commit}']);
  const initialHead = git(root, ['rev-parse', 'HEAD']);
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(dir, 'blobs'), { mode: 0o700 });
  const entries = inventory(root, (hash, bytes) => {
    const blob = join(dir, 'blobs', hash);
    if (statOrMissing(blob)) { if (digest(regularBytes(blob)) !== hash) throw new Error('Conflicting checkpoint blob'); }
    else durable(blob, bytes);
  });
  if (input.fault === 'after-contents') throw new Error('Injected checkpoint interruption');
  const base = gitNames(root, ['ls-tree', '-r', '-z', '--name-only', baseOid]);
  base.forEach(validPath);
  const present = new Set(entries.map(entry => entry.path));
  const deleted = base.filter(path => !present.has(path));
  const bundle = join(dir, 'base.bundle');
  git(root, ['bundle', 'create', bundle, '--all']);
  const bundleDigest = digest(regularBytes(bundle));
  const objectProof = join(dir, 'object-proof');
  try {
    git(dir, ['init', '--bare', objectProof]);
    git(objectProof, ['bundle', 'unbundle', bundle]);
    git(objectProof, ['cat-file', '-e', baseOid + '^{commit}']);
  } finally { rmSync(objectProof, { recursive: true, force: true }); }
  syncPath(bundle);
  syncPath(join(dir, 'blobs'));
  if (git(root, ['rev-parse', 'HEAD']) !== initialHead || JSON.stringify(inventory(root)) !== JSON.stringify(entries)) throw new Error('Source changed during checkpoint capture');
  const body = { version: 1 as const, baseRef: input.baseRef, baseOid, bundleDigest, entries, deleted, metadata: input.metadata };
  const raw = JSON.stringify(body) + '\n';
  if (input.fault === 'before-manifest') throw new Error('Injected checkpoint interruption');
  durable(join(dir, 'manifest.json'), raw);
  syncPath(dir);
  syncPath(dirname(dir));
  if (input.fault === 'after-manifest') throw new Error('Injected checkpoint interruption');
  const manifestDigest = digest(raw);
  input.journal.append('checkpoint.recoverable', 'Checkpoint content and manifest are durable', { checkpointDir: dir, manifestDigest });
  return { ...body, manifestDigest };
}

export async function verifyCheckpoint(checkpointDir: string, journal: Journal): Promise<CheckpointManifest> {
  if (!isAbsolute(checkpointDir)) throw new Error('Absolute checkpoint path required');
  const dir = resolve(checkpointDir);
  realDirectories(dir);
  const raw = regularBytes(join(dir, 'manifest.json'));
  const manifestDigest = digest(raw);
  const event = journal.records.find(record => record.type === 'checkpoint.recoverable' && record.details.checkpointDir === dir && record.details.manifestDigest === manifestDigest);
  if (!event) throw new Error('Checkpoint is not recoverable');
  const parsed = JSON.parse(raw.toString('utf8')) as CheckpointManifest;
  if (parsed.version !== 1 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed.baseOid) || typeof parsed.baseRef !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.bundleDigest) || !Array.isArray(parsed.entries) || !Array.isArray(parsed.deleted) ||
    !parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata) || digest(regularBytes(join(dir, 'base.bundle'))) !== parsed.bundleDigest) throw new Error('Corrupt checkpoint manifest');
  const seen = new Set<string>();
  for (const path of [...parsed.entries.map(entry => entry.path), ...parsed.deleted]) {
    validPath(path);
    if (seen.has(path)) throw new Error('Duplicate checkpoint path');
    seen.add(path);
  }
  const entryPaths = new Set(parsed.entries.map(entry => entry.path));
  for (const entry of parsed.entries) {
    let parent = posix.dirname(entry.path);
    while (parent !== '.') {
      if (entryPaths.has(parent)) throw new Error('File or symlink used as a checkpoint parent');
      parent = posix.dirname(parent);
    }
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('Invalid checkpoint mode');
    if (entry.kind === 'file') {
      if (typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.size) || entry.size! < 0) throw new Error('Invalid checkpoint blob');
      const bytes = regularBytes(join(dir, 'blobs', entry.digest));
      if (digest(bytes) !== entry.digest || bytes.length !== entry.size) throw new Error('Corrupt checkpoint blob');
    } else if (entry.kind !== 'symlink' || typeof entry.target !== 'string' || entry.target.includes('\0')) throw new Error('Invalid checkpoint entry');
  }
  return { ...parsed, manifestDigest };
}

export async function restoreCheckpoint(checkpointDir: string, destination: string, journal: Journal): Promise<{ repo: string; worktree: string; manifest: CheckpointManifest }> {
  const manifest = await verifyCheckpoint(checkpointDir, journal);
  if (!isAbsolute(destination)) throw new Error('Absolute restore destination required');
  const root = resolve(destination);
  realDirectories(dirname(root));
  if (statOrMissing(root)) throw new Error('Restore destination must be new');
  mkdirSync(root, { mode: 0o700 });
  const rootIdentity = lstatSync(root);
  const repo = join(root, 'repo');
  const worktree = join(repo, '.worktrees', 'run');
  try {
    git(root, ['clone', '--no-checkout', resolve(checkpointDir, 'base.bundle'), repo]);
    git(repo, ['cat-file', '-e', manifest.baseOid + '^{commit}']);
    mkdirSync(join(repo, '.worktrees'), { recursive: true });
    git(repo, ['worktree', 'add', '-b', 'restored', worktree, manifest.baseOid]);
    for (const entry of readdirSync(worktree)) if (entry !== '.git') rmSync(join(worktree, entry), { recursive: true, force: true });
    for (const entry of manifest.entries.filter(item => item.kind === 'file')) {
      const path = join(worktree, entry.path);
      realDirectories(dirname(path));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, regularBytes(join(checkpointDir, 'blobs', entry.digest!)), { flag: 'wx', mode: entry.mode });
      chmodSync(path, entry.mode);
      syncPath(path);
    }
    for (const entry of manifest.entries.filter(item => item.kind === 'symlink')) {
      const path = join(worktree, entry.path);
      realDirectories(dirname(path));
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(entry.target!, path);
    }
    if (JSON.stringify(inventory(worktree)) !== JSON.stringify(manifest.entries)) throw new Error('Restored content does not match checkpoint');
    syncPath(worktree);
    return { repo, worktree, manifest };
  } catch (error) {
    const current = lstatSync(root);
    if (!current.isSymbolicLink() && current.dev === rootIdentity.dev && current.ino === rootIdentity.ino) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
