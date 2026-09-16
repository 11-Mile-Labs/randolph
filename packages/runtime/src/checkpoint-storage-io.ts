import { join } from 'node:path';
import {
  MANIFEST_LIMIT,
  PACK_LIMIT,
  SHA256,
  checkpointBody,
  validateManifest,
  type CheckpointManifest,
} from './checkpoint-manifest.js';
import {
  canonicalDirectory,
  hashBytes,
  inspectRegularFile,
  readBoundedFile,
} from './checkpoint-file-io.js';

export type {
  CheckpointManifest,
  JsonValue,
  StoredCheckpointManifest,
} from './checkpoint-manifest.js';
export {
  FILE_LIMIT,
  GIT_OID,
  MANIFEST_LIMIT,
  METADATA_LIMIT,
  PACK_LIMIT,
  PATH_LIMIT,
  SHA256,
  SNAPSHOT_LIMIT,
  checkpointBody,
  normalizeJson,
  normalizeMetadata,
  validateManifest,
} from './checkpoint-manifest.js';
export {
  assertOwnedDirectory,
  canonicalDirectory,
  exists,
  hashBytes,
  inspectRegularFile,
  missing,
  overlaps,
  readBoundedFile,
  syncPath,
  writeDurable,
} from './checkpoint-file-io.js';
export type { TreeEntry } from './checkpoint-git-objects.js';
export {
  gitText,
  materializeBlob,
  safeGitEnvironment,
  safeGitInit,
  treeEntries,
  validateSnapshot,
  verifyStandalonePack,
} from './checkpoint-git-objects.js';

export function loadCheckpoint(directory: string, expectedDigest: string): CheckpointManifest {
  const checkpoint = canonicalDirectory(directory, 'Checkpoint directory');
  if (!SHA256.test(expectedDigest)) throw new Error('Expected checkpoint digest is invalid.');
  const raw = readBoundedFile(
    join(checkpoint, 'manifest.json'),
    MANIFEST_LIMIT,
    'Checkpoint manifest',
  );
  if (hashBytes(raw) !== expectedDigest)
    throw new Error('Checkpoint manifest digest does not match the selected checkpoint.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Checkpoint manifest is corrupt.');
  }
  const stored = validateManifest(parsed);
  if (!checkpointBody(stored).equals(raw)) throw new Error('Checkpoint manifest is not canonical.');
  const pack = inspectRegularFile(
    join(checkpoint, 'objects.pack'),
    PACK_LIMIT,
    'Checkpoint object pack',
  );
  const index = inspectRegularFile(
    join(checkpoint, 'objects.idx'),
    MANIFEST_LIMIT * 16,
    'Checkpoint object index',
  );
  if (
    pack.bytes !== stored.pack.bytes ||
    pack.sha256 !== stored.pack.sha256 ||
    index.bytes !== stored.pack.indexBytes ||
    index.sha256 !== stored.pack.indexSha256
  )
    throw new Error('Checkpoint object storage is corrupt.');
  return { ...stored, digest: expectedDigest, directory: checkpoint };
}
