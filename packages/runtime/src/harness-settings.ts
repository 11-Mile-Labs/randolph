import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Document, isMap, parseDocument } from 'yaml';

export type HarnessDefaults = { harness: 'codex'; model: string; effort: string };
export type HarnessSettings = { revision: string | null; defaults: HarnessDefaults | null; error?: string };
const MAX_BYTES = 64 * 1024;
const FILE_NAME = 'config.harness.yaml';

function validateDefaults(value: unknown): HarnessDefaults {
  if (!value || typeof value !== 'object') throw new Error('Harness settings must contain a model and effort.');
  const { harness, model, effort } = value as Record<string, unknown>;
  const validText = (text: unknown, max: number): text is string => typeof text === 'string'
    && text.length > 0 && text.length <= max && text.trim() === text
    && !Array.from(text).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (harness !== 'codex' || !validText(model, 200) || !validText(effort, 32)) {
    throw new Error('Harness settings require harness codex and nonempty, bounded model and effort names.');
  }
  return { harness, model, effort };
}

function verifyRoot(root: string): void {
  try {
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== resolve(root)) throw new Error('redirected');
  } catch {
    throw new Error('Project directory is missing or redirected. Re-add the project before editing harness settings.');
  }
}

function readSource(root: string): Buffer | null {
  verifyRoot(root);
  const path = join(root, FILE_NAME);
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.nlink !== 1) throw new Error(`${FILE_NAME} must be a regular file without links.`);
  if (before.size > MAX_BYTES) throw new Error(`${FILE_NAME} exceeds the 64 KB size limit.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino) {
      throw new Error(`${FILE_NAME} changed or is an unsafe link. Reload settings.`);
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error(`${FILE_NAME} exceeds the 64 KB size limit.`);
    verifyRoot(root);
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

function parseSource(bytes: Buffer): { document: Document; defaults: HarnessDefaults } {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw new Error(`${FILE_NAME} must contain valid YAML with unique keys and no unsupported tags.`);
  }
  const value = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error(`${FILE_NAME} requires schemaVersion: 1.`);
  return { document, defaults: validateDefaults(value) };
}

function revision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readHarnessSettings(root: string): HarnessSettings {
  let currentRevision: string | null = null;
  try {
    const bytes = readSource(root);
    if (!bytes) return { revision: null, defaults: null };
    currentRevision = revision(bytes);
    return { revision: currentRevision, defaults: parseSource(bytes).defaults };
  } catch (error) {
    return { revision: currentRevision, defaults: null, error: error instanceof Error ? error.message : 'Cannot read project harness settings.' };
  }
}

export function writeHarnessSettings(root: string, defaults: HarnessDefaults, expectedRevision: string | null): HarnessSettings {
  const selected = validateDefaults(defaults);
  const bytes = readSource(root);
  const parsed = bytes ? parseSource(bytes) : null;
  const currentRevision = bytes ? revision(bytes) : null;
  if (currentRevision !== expectedRevision) throw new Error('Project harness settings changed outside this editor. Reload before saving.');
  const document = parsed?.document ?? new Document({ schemaVersion: 1 });
  for (const [key, value] of Object.entries(selected)) document.set(key, value);
  const output = Buffer.from(document.toString(), 'utf8');
  if (output.length > MAX_BYTES) throw new Error(`${FILE_NAME} exceeds the 64 KB size limit.`);
  const temporary = join(root, `.${FILE_NAME}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      writeFileSync(fd, output);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const latest = readHarnessSettings(root);
    if (latest.error) throw new Error(latest.error);
    if (latest.revision !== expectedRevision) throw new Error('Project harness settings changed outside this editor. Reload before saving.');
    renameSync(temporary, join(root, FILE_NAME));
    created = false;
    return { revision: revision(output), defaults: selected };
  } finally {
    if (created) unlinkSync(temporary);
  }
}
