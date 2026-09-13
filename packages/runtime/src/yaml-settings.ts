import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Document, isMap, parseDocument } from 'yaml';

export type YamlSettings<T> = { revision: string | null; value: T; error?: string };
const MAX_BYTES = 64 * 1024;

function verifyRoot(root: string): void {
  try {
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== resolve(root)) throw new Error('redirected');
  } catch {
    throw new Error('Project directory is missing or redirected. Re-add the project before editing settings.');
  }
}

function readSource(root: string, fileName: string): Buffer | null {
  verifyRoot(root);
  const path = join(root, fileName);
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.nlink !== 1) throw new Error(`${fileName} must be a regular file without links.`);
  if (before.size > MAX_BYTES) throw new Error(`${fileName} exceeds the 64 KB size limit.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino) {
      throw new Error(`${fileName} changed or is an unsafe link. Reload settings.`);
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error(`${fileName} exceeds the 64 KB size limit.`);
    verifyRoot(root);
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

function parseSource<T>(bytes: Buffer, fileName: string, validate: (value: unknown) => T): { document: Document; value: T } {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw new Error(`${fileName} must contain valid YAML with unique keys and no unsupported tags.`);
  }
  const value = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error(`${fileName} requires schemaVersion: 1.`);
  return { document, value: validate(value) };
}

function revision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readYamlSettings<T>(root: string, fileName: string, validate: (value: unknown) => T, fallback: T): YamlSettings<T> {
  let currentRevision: string | null = null;
  try {
    const bytes = readSource(root, fileName);
    if (!bytes) return { revision: null, value: fallback };
    currentRevision = revision(bytes);
    return { revision: currentRevision, value: parseSource(bytes, fileName, validate).value };
  } catch (error) {
    return { revision: currentRevision, value: fallback, error: error instanceof Error ? error.message : 'Cannot read project settings.' };
  }
}

export function writeYamlSettings<T extends Record<string, unknown>>(root: string, fileName: string, values: T, expectedRevision: string | null, validate: (value: unknown) => T): YamlSettings<T> {
  const selected = validate(values);
  const bytes = readSource(root, fileName);
  const parsed = bytes ? parseSource(bytes, fileName, validate) : null;
  const currentRevision = bytes ? revision(bytes) : null;
  if (currentRevision !== expectedRevision) throw new Error('Project settings changed outside this editor. Reload before saving.');
  const document = parsed?.document ?? new Document({ schemaVersion: 1 });
  for (const [key, value] of Object.entries(selected)) document.set(key, value);
  const output = Buffer.from(document.toString(), 'utf8');
  if (output.length > MAX_BYTES) throw new Error(`${fileName} exceeds the 64 KB size limit.`);
  const temporary = join(root, `.${fileName}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      writeFileSync(fd, output);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const latest = readYamlSettings(root, fileName, validate, selected);
    if (latest.error) throw new Error(latest.error);
    if (latest.revision !== expectedRevision) throw new Error('Project settings changed outside this editor. Reload before saving.');
    renameSync(temporary, join(root, fileName));
    created = false;
    return { revision: revision(output), value: selected };
  } finally {
    if (created) unlinkSync(temporary);
  }
}
