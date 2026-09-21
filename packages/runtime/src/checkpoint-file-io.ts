import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${label} must be an absolute canonical path.`);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (missing(error)) throw new Error(`${label} does not exist.`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error(`${label} must be a real directory without symlink traversal.`);
  return path;
}

export function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}

export function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeDurable(path: string, bytes: string | Buffer): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function hashBytes(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function inspectRegularFile(
  path: string,
  limit: number,
  label: string,
): { bytes: number; sha256: string } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
    throw new Error(`${label} is linked, nonregular, or exceeds the supported limit.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash('sha256');
  try {
    const actual = fstatSync(fd);
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.size !== before.size ||
      actual.size > limit
    )
      throw new Error(`${label} changed while it was being read.`);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (total < actual.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, actual.size - total), null);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
      total += count;
    }
    const after = fstatSync(fd);
    if (total !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs)
      throw new Error(`${label} changed while it was being read.`);
    return { bytes: total, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

export function readBoundedFile(path: string, limit: number, label: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
    throw new Error(`${label} is linked, nonregular, or exceeds the supported limit.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd);
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.size !== before.size ||
      actual.size > limit
    )
      throw new Error(`${label} changed while it was being read.`);
    const bytes = Buffer.alloc(actual.size);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (!count) break;
      total += count;
    }
    const after = fstatSync(fd);
    if (total !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs)
      throw new Error(`${label} changed while it was being read.`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function assertOwnedDirectory(path: string, identity: Stats): void {
  const current = lstatSync(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    throw new Error('Restore destination was replaced while files were being written.');
}
