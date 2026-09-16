export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type StoredCheckpointManifest = {
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

export const FILE_LIMIT = 64 * 1024 * 1024;
export const SNAPSHOT_LIMIT = 512 * 1024 * 1024;
export const PACK_LIMIT = 512 * 1024 * 1024;
export const METADATA_LIMIT = 1024 * 1024;
export const MANIFEST_LIMIT = 2 * 1024 * 1024;
export const PATH_LIMIT = 100_000;
export const SHA256 = /^[0-9a-f]{64}$/;
export const GIT_OID = /^[0-9a-f]{40,64}$/;

export function normalizeJson(
  value: unknown,
  depth: number,
  arrayItem: boolean,
  count: { value: number },
): JsonValue | undefined {
  if (++count.value > 100_000 || depth > 100)
    throw new Error('Checkpoint metadata is too deeply nested or contains too many values.');
  if (value === undefined) return arrayItem ? null : undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Checkpoint metadata contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => normalizeJson(item, depth + 1, true, count) ?? null);
  if (typeof value !== 'object')
    throw new Error('Checkpoint metadata must contain only JSON values.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Checkpoint metadata must contain only plain JSON objects.');
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeJson(
      (value as Record<string, unknown>)[key],
      depth + 1,
      false,
      count,
    );
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

export function normalizeMetadata(metadata: Record<string, unknown>): {
  value: Record<string, JsonValue>;
  bytes: Buffer;
} {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Checkpoint metadata must be a JSON object.');
  const value = normalizeJson(metadata, 0, false, { value: 0 }) as Record<string, JsonValue>;
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > METADATA_LIMIT)
    throw new Error('Checkpoint metadata exceeds the supported 1 MiB limit.');
  return { value, bytes };
}

export function checkpointBody(manifest: StoredCheckpointManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest) + '\n', 'utf8');
}

export function validateManifest(value: unknown): StoredCheckpointManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Checkpoint manifest is corrupt.');
  const manifest = value as StoredCheckpointManifest;
  if (
    manifest.version !== 1 ||
    !/^[0-9a-f-]{36}$/.test(manifest.id) ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    !['sha1', 'sha256'].includes(manifest.objectFormat) ||
    !GIT_OID.test(manifest.baseCommitOid) ||
    !GIT_OID.test(manifest.snapshotTreeOid) ||
    !GIT_OID.test(manifest.snapshotCommitOid) ||
    !manifest.metadata ||
    typeof manifest.metadata !== 'object' ||
    Array.isArray(manifest.metadata) ||
    !manifest.pack ||
    typeof manifest.pack !== 'object' ||
    !GIT_OID.test(manifest.pack.gitHash) ||
    !Number.isSafeInteger(manifest.pack.bytes) ||
    manifest.pack.bytes < 0 ||
    manifest.pack.bytes > PACK_LIMIT ||
    !SHA256.test(manifest.pack.sha256) ||
    !Number.isSafeInteger(manifest.pack.indexBytes) ||
    manifest.pack.indexBytes < 0 ||
    manifest.pack.indexBytes > MANIFEST_LIMIT * 16 ||
    !SHA256.test(manifest.pack.indexSha256)
  )
    throw new Error('Checkpoint manifest is corrupt.');
  const normalized = normalizeMetadata(manifest.metadata);
  if (!normalized.bytes.equals(Buffer.from(JSON.stringify(manifest.metadata), 'utf8')))
    throw new Error('Checkpoint metadata is not canonical.');
  return manifest;
}
