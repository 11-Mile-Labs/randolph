import { workspaceCleanupConfirmed } from './workspace-operation.js';
import {
  constants,
  copyFileSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runSafeGit } from './git-execution.js';
import { captureGitTree } from './git-workspace-snapshot.js';
import {
  GIT_OID,
  MANIFEST_LIMIT,
  PACK_LIMIT,
  assertOwnedDirectory,
  syncPath,
  type StoredCheckpointManifest,
  canonicalDirectory,
  checkpointBody,
  exists,
  gitText,
  hashBytes,
  inspectRegularFile,
  loadCheckpoint,
  materializeBlob,
  normalizeMetadata,
  overlaps,
  safeGitInit,
  treeEntries,
  validateSnapshot,
  verifyStandalonePack,
  writeDurable,
  type CheckpointManifest,
} from './checkpoint-storage-io.js';

export type { CheckpointManifest } from './checkpoint-storage-io.js';

export function createCheckpoint(
  workspace: string,
  evidenceDirectory: string,
  metadata: Record<string, unknown>,
): CheckpointManifest {
  const source = canonicalDirectory(workspace, 'Checkpoint workspace');
  const evidence = canonicalDirectory(evidenceDirectory, 'Checkpoint evidence directory');
  if (gitText(source, ['rev-parse', '--show-toplevel']) !== source)
    throw new Error('Checkpoint workspace must be the root of a Git worktree.');
  const commonDirectory = canonicalDirectory(
    gitText(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    'Git common directory',
  );
  const repositoryRoot =
    basename(commonDirectory) === '.git' ? dirname(commonDirectory) : commonDirectory;
  if (overlaps(source, evidence) || overlaps(repositoryRoot, evidence))
    throw new Error('Checkpoint evidence must be outside the source repository.');
  const normalized = normalizeMetadata(metadata);
  const objectFormat = gitText(source, ['rev-parse', '--show-object-format']);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    throw new Error('Checkpoint repository uses an unsupported Git object format.');
  const baseCommitOid = gitText(source, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!GIT_OID.test(baseCommitOid))
    throw new Error('Checkpoint base commit has an unsupported object ID.');
  const id = randomUUID();
  const pending = join(evidence, `.checkpoint-${id}.pending`);
  const directory = join(evidence, `checkpoint-${id}`);
  mkdirSync(pending, { mode: 0o700 });
  let published = false;
  try {
    const snapshotTreeOid = captureGitTree(source, pending);
    validateSnapshot(source, snapshotTreeOid);
    if (
      captureGitTree(source, pending) !== snapshotTreeOid ||
      gitText(source, ['rev-parse', '--verify', 'HEAD^{commit}']) !== baseCommitOid
    )
      throw new Error('Checkpoint workspace changed while it was being captured.');
    const snapshotCommitOid = gitText(
      source,
      ['hash-object', '-w', '-t', 'commit', '--stdin'],
      `tree ${snapshotTreeOid}\nparent ${baseCommitOid}\nauthor Randolph Checkpoint <checkpoint@localhost> 0 +0000\ncommitter Randolph Checkpoint <checkpoint@localhost> 0 +0000\n\nRetained checkpoint ${id}.\n`,
    );
    const prefix = join(pending, 'retained');
    const packHash = gitText(
      source,
      ['pack-objects', '--revs', '--index-version=2', prefix],
      `${snapshotCommitOid}\n`,
    );
    if (!GIT_OID.test(packHash))
      throw new Error('Git returned an unsupported checkpoint pack identity.');
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
      pack: {
        gitHash: packHash,
        bytes: pack.bytes,
        sha256: pack.sha256,
        indexBytes: index.bytes,
        indexSha256: index.sha256,
      },
    };
    const raw = checkpointBody(stored);
    if (raw.length > MANIFEST_LIMIT)
      throw new Error('Checkpoint manifest exceeds the supported 2 MiB limit.');
    verifyStandalonePack(source, packPath, indexPath, packHash, stored);
    syncPath(packPath);
    syncPath(indexPath);
    writeDurable(join(pending, 'manifest.json'), raw);
    syncPath(pending);
    if (
      captureGitTree(source, pending) !== snapshotTreeOid ||
      gitText(source, ['rev-parse', '--verify', 'HEAD^{commit}']) !== baseCommitOid
    )
      throw new Error('Checkpoint workspace changed before durable publication.');
    renameSync(pending, directory);
    published = true;
    syncPath(evidence);
    return { ...stored, digest: hashBytes(raw), directory };
  } catch (error) {
    if (workspaceCleanupConfirmed(error))
      rmSync(published ? directory : pending, { force: true, recursive: true });
    throw error;
  }
}

export function readCheckpoint(directory: string, expectedDigest: string): CheckpointManifest {
  return loadCheckpoint(directory, expectedDigest);
}

export function restoreCheckpoint(
  directory: string,
  expectedDigest: string,
  destination: string,
): { workspace: string; manifest: CheckpointManifest } {
  const manifest = readCheckpoint(directory, expectedDigest);
  if (!isAbsolute(destination) || resolve(destination) !== destination)
    throw new Error('Restore destination must be an absolute canonical path.');
  const parent = canonicalDirectory(dirname(destination), 'Restore destination parent');
  if (exists(destination))
    throw new Error(
      'Restore destination must be a new directory. Existing files are never overwritten.',
    );
  if (overlaps(manifest.directory, destination))
    throw new Error('Restore destination must be outside the checkpoint directory.');
  if (realpathSync(parent) !== parent)
    throw new Error('Restore destination parent was redirected.');
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
    if (
      inspectRegularFile(restoredPack, PACK_LIMIT, 'Restored object pack').sha256 !==
        manifest.pack.sha256 ||
      inspectRegularFile(restoredIndex, MANIFEST_LIMIT * 16, 'Restored object index').sha256 !==
        manifest.pack.indexSha256
    )
      throw new Error('Restored checkpoint objects do not match retained storage.');
    gitText(destination, ['verify-pack', '-s', restoredIndex]);
    gitText(destination, ['cat-file', '-e', `${manifest.baseCommitOid}^{commit}`]);
    gitText(destination, ['cat-file', '-e', `${manifest.snapshotTreeOid}^{tree}`]);
    gitText(destination, [
      'fsck',
      '--connectivity-only',
      '--no-reflogs',
      manifest.snapshotCommitOid,
    ]);
    runSafeGit(destination, ['read-tree', manifest.baseCommitOid]);
    gitText(destination, ['update-ref', '--no-deref', 'HEAD', manifest.baseCommitOid]);
    assertOwnedDirectory(destination, identity);
    for (const entry of treeEntries(destination, manifest.snapshotTreeOid).sort(
      (left, right) => Number(left.mode === '120000') - Number(right.mode === '120000'),
    ))
      materializeBlob(destination, entry);
    assertOwnedDirectory(destination, identity);
    const gitDirectory = canonicalDirectory(join(destination, '.git'), 'Restored Git directory');
    let attached = false;
    try {
      gitText(destination, ['symbolic-ref', '-q', 'HEAD']);
      attached = true;
    } catch (error) {
      if (!workspaceCleanupConfirmed(error)) throw error; /* Detached HEAD is required. */
    }
    if (
      captureGitTree(destination, gitDirectory) !== manifest.snapshotTreeOid ||
      captureGitTree(destination, gitDirectory) !== manifest.snapshotTreeOid ||
      gitText(destination, ['rev-parse', '--verify', 'HEAD^{commit}']) !== manifest.baseCommitOid ||
      attached
    )
      throw new Error('Restored checkpoint content or base identity does not match the manifest.');
    return { workspace: destination, manifest };
  } catch (error) {
    try {
      if (workspaceCleanupConfirmed(error)) {
        assertOwnedDirectory(destination, identity);
        rmSync(destination, { force: true, recursive: true });
      }
    } catch {
      /* Preserve a replaced destination rather than deleting an unknown path. */
    }
    throw error;
  }
}
