import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Journal } from '../src/evidence.js';
import { createFixture, git, removeFixture } from '../src/fixture.js';
import { captureCheckpoint, restoreCheckpoint, verifyCheckpoint } from '../src/checkpoint.js';

const root = join(homedir(), '.cache', `randolph-checkpoint-${randomUUID()}`);
mkdirSync(root, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

test('captures and restores content independently of the source repository', async () => {
  const fixture = await createFixture(join(root, 'fixture'), join(root, 'evidence'));
  const journal = new Journal(join(root, 'journal'));
  const checkpointDir = join(root, 'checkpoint');
  try {
    writeFileSync(join(fixture.worktree, 'untracked.txt'), 'changed\n');
    chmodSync(join(fixture.worktree, 'artifact.bin'), 0o755);
    symlinkSync('untracked.txt', join(fixture.worktree, 'link.txt'));
    const manifest = await captureCheckpoint({
      worktree: fixture.worktree,
      checkpointDir,
      baseRef: fixture.baseline,
      metadata: { pending: ['verify'] },
      journal,
    });
    assert.equal(
      (await verifyCheckpoint(checkpointDir, journal)).manifestDigest,
      manifest.manifestDigest,
    );
    await removeFixture(fixture);
    const restored = await restoreCheckpoint(checkpointDir, join(root, 'restored'), journal);
    assert.equal(readFileSync(join(restored.worktree, 'untracked.txt'), 'utf8'), 'changed\n');
    assert.equal(readFileSync(join(restored.worktree, 'artifact.bin')).length, 5);
    assert.equal(readFileSync(join(restored.worktree, 'link.txt'), 'utf8'), 'changed\n');
    assert.equal(git(restored.worktree, ['rev-parse', 'HEAD']), fixture.baseline);
  } finally {
    rmSync(join(root, 'restored'), { recursive: true, force: true });
  }
});

test('fails closed when content or recoverability evidence is incomplete', async () => {
  const fixture = await createFixture(join(root, 'fault-fixture'), join(root, 'fault-evidence'));
  const journal = new Journal(join(root, 'fault-journal'));
  try {
    await assert.rejects(() =>
      captureCheckpoint({
        worktree: fixture.worktree,
        checkpointDir: join(root, 'fault-checkpoint'),
        baseRef: fixture.baseline,
        metadata: {},
        journal,
        fault: 'after-contents',
      }),
    );
    await assert.rejects(() => verifyCheckpoint(join(root, 'fault-checkpoint'), journal));
  } finally {
    await removeFixture(fixture);
  }
});

test('preserves deletions, modes, transitions, duplicate blobs, and dangling links', async () => {
  const fixture = await createFixture(join(root, 'proof-fixture'), join(root, 'proof-evidence'));
  const journal = new Journal(join(root, 'proof-journal'));
  const checkpointDir = join(root, 'proof-checkpoint');
  try {
    writeFileSync(join(fixture.worktree, 'old.txt'), 'delete me\n');
    writeFileSync(join(fixture.worktree, 'swap-file'), 'regular\n');
    writeFileSync(join(fixture.worktree, 'become-link'), 'old regular file\n');
    symlinkSync('swap-file', join(fixture.worktree, 'swap-link'));
    writeFileSync(join(fixture.worktree, 'duplicate-a'), 'same\n');
    writeFileSync(join(fixture.worktree, 'duplicate-b'), 'same\n');
    symlinkSync(join(root, 'outside-sentinel'), join(fixture.worktree, 'dangling-link'));
    git(fixture.worktree, ['add', 'old.txt', 'swap-file', 'swap-link', 'become-link']);
    git(fixture.worktree, ['commit', '-m', 'checkpoint base']);
    const nonMainOid = git(fixture.worktree, ['rev-parse', 'HEAD']);
    assert.notEqual(nonMainOid, git(fixture.repo, ['rev-parse', 'main']));
    rmSync(join(fixture.worktree, 'become-link'));
    symlinkSync('swap-link', join(fixture.worktree, 'become-link'));
    rmSync(join(fixture.worktree, 'old.txt'));
    rmSync(join(fixture.worktree, 'swap-file'));
    writeFileSync(join(fixture.worktree, 'swap-file'), 'now regular\n');
    chmodSync(join(fixture.worktree, 'swap-file'), 0o755);
    rmSync(join(fixture.worktree, 'swap-link'));
    writeFileSync(join(fixture.worktree, 'swap-link'), 'now file\n');
    const manifest = await captureCheckpoint({
      worktree: fixture.worktree,
      checkpointDir,
      baseRef: 'HEAD',
      metadata: { completed: ['capture'] },
      journal,
    });
    assert.ok(manifest.deleted.includes('old.txt'));
    assert.equal(lstatSync(join(fixture.worktree, 'swap-file')).mode & 0o111, 0o111);
    assert.equal(
      readlinkSafe(join(fixture.worktree, 'dangling-link')),
      join(root, 'outside-sentinel'),
    );
    const blobs = readdirSync(join(checkpointDir, 'blobs'));
    assert.equal(
      blobs.filter(
        (name) => name === manifest.entries.find((entry) => entry.path === 'duplicate-a')?.digest,
      ).length,
      1,
    );
    await removeFixture(fixture);
    const restored = await restoreCheckpoint(checkpointDir, join(root, 'proof-restored'), journal);
    assert.equal(git(restored.worktree, ['rev-parse', 'HEAD']), nonMainOid);
    assert.equal(readlinkSync(join(restored.worktree, 'become-link')), 'swap-link');
    assert.equal(existsSafe(join(restored.worktree, 'old.txt')), false);
    assert.equal(readFileSync(join(restored.worktree, 'swap-link'), 'utf8'), 'now file\n');
    assert.equal(lstatSync(join(restored.worktree, 'swap-file')).mode & 0o111, 0o111);
    assert.equal(
      readlinkSafe(join(restored.worktree, 'dangling-link')),
      join(root, 'outside-sentinel'),
    );
  } finally {
    rmSync(join(root, 'proof-restored'), { recursive: true, force: true });
    if (existsSafe(fixture.root)) await removeFixture(fixture).catch(() => undefined);
  }
});

test('requires a recoverability event and rejects corrupt content', async () => {
  const fixture = await createFixture(
    join(root, 'fault-proof-fixture'),
    join(root, 'fault-proof-evidence'),
  );
  const journal = new Journal(join(root, 'fault-proof-journal'));
  try {
    for (const [index, fault] of (
      ['after-contents', 'before-manifest', 'after-manifest'] as const
    ).entries()) {
      const dir = join(root, `fault-${index}`);
      await assert.rejects(() =>
        captureCheckpoint({
          worktree: fixture.worktree,
          checkpointDir: dir,
          baseRef: fixture.baseline,
          metadata: {},
          journal,
          fault,
        }),
      );
      await assert.rejects(() => verifyCheckpoint(dir, journal));
    }
    const dir = join(root, 'corrupt');
    const manifest = await captureCheckpoint({
      worktree: fixture.worktree,
      checkpointDir: dir,
      baseRef: fixture.baseline,
      metadata: {},
      journal,
    });
    const blob = manifest.entries.find((entry) => entry.kind === 'file')?.digest;
    assert.ok(blob);
    writeFileSync(join(dir, 'blobs', blob!), 'corrupt');
    await assert.rejects(() => verifyCheckpoint(dir, journal));
  } finally {
    await removeFixture(fixture);
  }
});

const existsSafe = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const readlinkSafe = (path: string): string => readlinkSync(path);

test('rejects symlinked source, checkpoint and destination parents and altered storage', async () => {
  const fixture = await createFixture(join(root, 'paths-fixture'), join(root, 'paths-evidence'));
  const journal = new Journal(join(root, 'paths-journal'));
  const checkpointDir = join(root, 'paths-checkpoint');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const sentinel = join(outside, 'sentinel');
  writeFileSync(sentinel, 'keep');
  const alias = join(root, 'outside-alias');
  symlinkSync(outside, alias);
  const sourceAlias = join(root, 'source-alias');
  symlinkSync(fixture.worktree, sourceAlias);
  try {
    await assert.rejects(() =>
      captureCheckpoint({
        worktree: sourceAlias,
        checkpointDir,
        baseRef: 'HEAD',
        metadata: {},
        journal,
      }),
    );
    await assert.rejects(() =>
      captureCheckpoint({
        worktree: fixture.worktree,
        checkpointDir: join(alias, 'capture'),
        baseRef: 'HEAD',
        metadata: {},
        journal,
      }),
    );
    const manifest = await captureCheckpoint({
      worktree: fixture.worktree,
      checkpointDir,
      baseRef: 'HEAD',
      metadata: {},
      journal,
    });
    await assert.rejects(() => restoreCheckpoint(checkpointDir, join(alias, 'restore'), journal));
    assert.equal(existsSafe(join(outside, 'restore')), false);
    const blob = join(
      checkpointDir,
      'blobs',
      manifest.entries.find((entry) => entry.kind === 'file')!.digest!,
    );
    const bytes = readFileSync(blob);
    rmSync(blob);
    symlinkSync(sentinel, blob);
    await assert.rejects(() => verifyCheckpoint(checkpointDir, journal));
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
    rmSync(blob);
    writeFileSync(blob, bytes);
    const manifestPath = join(checkpointDir, 'manifest.json');
    const original = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, original.replace('"version":1', '"version":2'));
    await assert.rejects(() =>
      restoreCheckpoint(checkpointDir, join(root, 'tampered-restore'), journal),
    );
    assert.equal(existsSafe(join(root, 'tampered-restore')), false);
  } finally {
    await removeFixture(fixture);
  }
});

test('never publishes a checkpoint whose requested base is missing from the bundle', async () => {
  const fixture = await createFixture(
    join(root, 'unreachable-fixture'),
    join(root, 'unreachable-data'),
  );
  const journal = new Journal(join(root, 'unreachable-history'));
  try {
    const tree = git(fixture.worktree, ['rev-parse', 'HEAD^{tree}']);
    const orphan = git(fixture.worktree, ['commit-tree', tree, '-m', 'unreferenced test object']);
    assert.equal(git(fixture.worktree, ['cat-file', '-t', orphan]), 'commit');
    await assert.rejects(() =>
      captureCheckpoint({
        worktree: fixture.worktree,
        checkpointDir: join(root, 'unreachable-checkpoint'),
        baseRef: orphan,
        metadata: {},
        journal,
      }),
    );
    assert.equal(
      journal.records.some((event) => event.type === 'checkpoint.recoverable'),
      false,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test('source hardlinks cannot copy outside bytes into a recoverable checkpoint', async () => {
  const fixture = await createFixture(join(root, 'hardlink-fixture'), join(root, 'hardlink-data'));
  const journal = new Journal(join(root, 'hardlink-history'));
  const outside = join(root, 'outside-hardlink');
  writeFileSync(outside, 'outside bytes');
  linkSync(outside, join(fixture.worktree, 'linked-outside'));
  try {
    await assert.rejects(
      () =>
        captureCheckpoint({
          worktree: fixture.worktree,
          checkpointDir: join(root, 'hardlink-checkpoint'),
          baseRef: 'HEAD',
          metadata: {},
          journal,
        }),
      /Multiply linked/,
    );
    assert.equal(
      journal.records.some((event) => event.type === 'checkpoint.recoverable'),
      false,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'outside bytes');
  } finally {
    await removeFixture(fixture);
  }
});
