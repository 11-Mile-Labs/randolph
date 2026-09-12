import { randomUUID, createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExecutionMode, WorkspaceIdentity } from '@randolph/runtime/contracts';
import { assertWorkspaceIdentity } from '@randolph/runtime/workspace-identity';

const LIMIT = 1_048_576;
type Directory = { path: string; device: bigint; inode: bigint };
type FileSnapshot = { stat: BigIntStats; content: string; digest: string };
type ReadInput = { path: string; line?: number; limit?: number };
type WriteInput = { path: string; content: string };

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function statIfPresent(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw error; }
}
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
}
function textContent(buffer: Buffer): string {
  if (buffer.length > LIMIT || buffer.includes(0)) throw new Error('Only text files up to 1 MiB are supported.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}

/**
 * The runtime authorizes the exact managed worktree before constructing this boundary.
 * Operations reject redirects and revalidate identities before publication. These checks
 * detect ordinary concurrent edits; portable Node APIs do not provide a filesystem sandbox
 * or an atomic compare-and-swap rename against a hostile concurrent filesystem actor.
 */
export class WorkspaceFiles {
  private readonly workspace: string;
  private readonly identity: WorkspaceIdentity;
  private readonly mode: ExecutionMode;
  private readonly observed = new Map<string, Pick<FileSnapshot, 'stat' | 'digest'>>();
  constructor(options: { workspace: string; workspaceIdentity: WorkspaceIdentity; executionMode: ExecutionMode }) {
    this.workspace = options.workspace;
    this.identity = { ...options.workspaceIdentity };
    this.mode = options.executionMode;
    this.checkRoot();
  }
  private checkRoot(): void { assertWorkspaceIdentity(this.workspace, this.identity); }
  private path(input: string): string {
    this.checkRoot();
    if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0') || resolve(input) !== input
      || input.split(sep).some(part => part.toLowerCase() === '.git' || /\p{Cf}/u.test(part))) throw new Error('An absolute canonical workspace file path is required; Git metadata is protected.');
    const difference = relative(this.workspace, input);
    if (!difference || isAbsolute(difference) || difference === '..' || difference.startsWith(`..${sep}`)) throw new Error('File is outside the approved workspace.');
    return input;
  }
  private exactSpelling(path: string): void {
    // realpath can preserve an alias on case-insensitive or normalization-insensitive filesystems.
    if (!readdirSync(dirname(path)).includes(basename(path))) throw new Error('Workspace path spelling differs from its directory entry.');
  }
  private directory(path: string): Directory {
    const stat = lstatSync(path, { bigint: true });
    this.exactSpelling(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Workspace file parent is redirected or not a directory.');
    return { path, device: stat.dev, inode: stat.ino };
  }
  private verify(directories: Directory[]): void {
    this.checkRoot();
    for (const expected of directories) {
      const actual = this.directory(expected.path);
      if (actual.device !== expected.device || actual.inode !== expected.inode) throw new Error('Workspace file parent changed during access.');
    }
  }
  private parents(path: string, create: boolean, created: Directory[]): Directory[] {
    const directories: Directory[] = [];
    let current = this.workspace;
    for (const part of relative(this.workspace, dirname(path)).split(sep).filter(Boolean)) {
      this.verify(directories);
      current = join(current, part);
      if (!statIfPresent(current) && create) {
        mkdirSync(current, { mode: 0o755 });
        created.push(this.directory(current));
      }
      directories.push(this.directory(current));
    }
    this.verify(directories);
    return directories;
  }
  private snapshot(path: string): FileSnapshot | undefined {
    const before = statIfPresent(path);
    if (!before) return undefined;
    this.exactSpelling(path);
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(LIMIT)) throw new Error('Only singly linked regular text files up to 1 MiB are supported.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = fstatSync(fd, { bigint: true });
      if (!sameStat(before, initial)) throw new Error('Workspace file changed before reading.');
      const buffer = Buffer.alloc(LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytes = readSync(fd, buffer, length, buffer.length - length, length);
        if (!bytes) break;
        length += bytes;
      }
      const after = fstatSync(fd, { bigint: true });
      const current = statIfPresent(path);
      if (!sameStat(initial, after) || !current || !sameStat(after, current) || BigInt(length) !== after.size) throw new Error('Workspace file changed while reading.');
      const content = buffer.subarray(0, length);
      return { stat: after, content: textContent(content), digest: createHash('sha256').update(content).digest('hex') };
    } finally { closeSync(fd); }
  }
  read(input: ReadInput): { content: string } {
    const path = this.path(input.path);
    const start = input.line === undefined ? 0 : input.line - 1;
    const count = input.limit;
    if ((input.line !== undefined && typeof input.line !== 'number') || !Number.isSafeInteger(start) || start < 0
      || (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0))) throw new Error('Invalid line range.');
    const parents = this.parents(path, false, []);
    const file = this.snapshot(path);
    this.verify(parents);
    if (!file) throw new Error('Workspace file does not exist.');
    this.observed.set(path, { stat: file.stat, digest: file.digest });
    const lines = file.content.split('\n');
    return { content: lines.slice(start, count === undefined ? undefined : start + count).join('\n') };
  }
  write(input: WriteInput): Record<string, never> {
    this.checkRoot();
    if (this.mode !== 'code') throw new Error('Workspace is read-only.');
    const path = this.path(input.path);
    if (typeof input.content !== 'string') throw new Error('File content must be valid text.');
    if (Buffer.byteLength(input.content, 'utf8') > LIMIT) throw new Error('Only text files up to 1 MiB are supported.');
    const bytes = Buffer.from(input.content, 'utf8');
    if (textContent(bytes) !== input.content) throw new Error('File content must be valid UTF-8 text.');
    const created: Directory[] = [];
    let parents: Directory[] = [];
    let temporary: string | undefined;
    let temporaryStat: BigIntStats | undefined;
    let published = false;
    let publishedFile: FileSnapshot | undefined;
    try {
      parents = this.parents(path, true, created);
      const before = this.snapshot(path);
      const observed = this.observed.get(path);
      if (observed && (!before || !sameStat(observed.stat, before.stat) || observed.digest !== before.digest)) throw new Error('Workspace file changed since it was read; read the current file before editing.');
      this.verify(parents);
      temporary = join(dirname(path), `.randolph-write-${randomUUID()}.tmp`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        temporaryStat = fstatSync(fd, { bigint: true });
        writeFileSync(fd, bytes);
        fchmodSync(fd, before ? Number(before.stat.mode & 0o7777n) : 0o644);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      this.verify(parents);
      const staged = this.snapshot(temporary);
      if (!staged || staged.stat.dev !== temporaryStat.dev || staged.stat.ino !== temporaryStat.ino || staged.digest !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Staged workspace file changed during write.');
      const current = this.snapshot(path);
      if (before ? !current || !sameStat(before.stat, current.stat) || before.digest !== current.digest : current !== undefined) throw new Error('Workspace file changed during write; retry after reading the current file.');
      this.verify(parents);
      if (before) renameSync(temporary, path);
      else linkSync(temporary, path); // Exclusive publication: never clobber an externally created file.
      published = true;
      publishedFile = staged;
      // Fail closed against the published content even if cleanup or final verification fails.
      this.observed.set(path, { stat: staged.stat, digest: staged.digest });
      if (before) temporary = undefined;
    } finally {
      if (temporary && temporaryStat) {
        // Cleanup must not follow a redirected ancestor or delete a replacement file.
        try {
          this.verify(parents);
          const actual = statIfPresent(temporary);
          if (actual && actual.dev === temporaryStat.dev && actual.ino === temporaryStat.ino) unlinkSync(temporary);
        } catch { /* Retain the staged file if its safe location cannot be verified. */ }
      }
      if (!published) {
        for (const expected of created.reverse()) {
          try {
            this.checkRoot();
            const actual = this.directory(expected.path);
            if (actual.device === expected.device && actual.inode === expected.inode) rmdirSync(expected.path);
          } catch { /* Preserve nonempty or redirected directories. */ }
        }
      }
    }
    this.verify(parents);
    const final = this.snapshot(path);
    if (!final || !publishedFile || final.stat.dev !== publishedFile.stat.dev || final.stat.ino !== publishedFile.stat.ino || final.digest !== publishedFile.digest) throw new Error('Workspace file changed after publication; read the current file before editing.');
    this.verify(parents);
    // Capture after unlinking the staging name: exclusive creation temporarily adds a hard link.
    this.observed.set(path, { stat: final.stat, digest: final.digest });
    return {};
  }
}
