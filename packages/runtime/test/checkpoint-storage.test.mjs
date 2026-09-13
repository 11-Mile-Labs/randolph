import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCheckpoint, restoreCheckpoint } from '../dist/checkpoint-storage.js';

function git(directory, args) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', directory, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-checkpoint-storage-')));
  const workspace = join(directory, 'source');
  const evidence = join(directory, 'evidence');
  mkdirSync(workspace);
  mkdirSync(evidence);
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.name', 'Fixture']);
  git(workspace, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(workspace, 'history.txt'), 'ancestor\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'ancestor']);
  writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n.pack-proof/\n');
  writeFileSync(join(workspace, '.gitattributes'), '*.txt text eol=crlf\n');
  writeFileSync(join(workspace, 'changed.txt'), 'before\n');
  writeFileSync(join(workspace, 'deleted.txt'), 'remove me\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-m', 'base']);
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return { directory, evidence, workspace };
}

test('restores a raw worktree and base history after the source repository is deleted', t => {
  const source = fixture(t);
  const baseCommitOid = git(source.workspace, ['rev-parse', 'HEAD']);
  const originalIndex = readFileSync(join(source.workspace, git(source.workspace, ['rev-parse', '--git-path', 'index'])));
  const marker = join(source.directory, 'filter-ran');
  git(source.workspace, ['config', 'filter.bad.clean', `touch '${marker}'; cat`]);
  git(source.workspace, ['config', 'filter.bad.smudge', `touch '${marker}'; cat`]);
  writeFileSync(join(source.workspace, '.gitattributes'), '*.txt filter=bad text eol=crlf\n');
  writeFileSync(join(source.workspace, 'changed.txt'), 'after\n');
  unlinkSync(join(source.workspace, 'deleted.txt'));
  writeFileSync(join(source.workspace, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(source.workspace, 'run.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(source.workspace, 'run.sh'), 0o755);
  writeFileSync(join(source.workspace, 'untracked.txt'), 'kept\n');
  writeFileSync(join(source.workspace, 'ignored.txt'), 'scratch\n');
  mkdirSync(join(source.workspace, '.pack-proof'));
  writeFileSync(join(source.workspace, '.pack-proof', 'sentinel'), 'source-owned\n');
  symlinkSync('untracked.txt', join(source.workspace, 'link'));
  const statusBefore = git(source.workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  rmSync(marker, { force: true });

  const manifest = createCheckpoint(source.workspace, source.evidence, {
    pending: ['review'],
    absent: undefined,
    nested: { z: 1, a: true },
    prototypeKey: JSON.parse('{"__proto__":"retained as data"}'),
  });
  assert.equal(manifest.baseCommitOid, baseCommitOid);
  assert.equal(manifest.metadata.absent, undefined);
  assert.equal(lstatSync(manifest.directory).isDirectory(), true);
  const manifestBytes = readFileSync(join(manifest.directory, 'manifest.json'), 'utf8');
  assert.equal(manifestBytes.includes(source.workspace), false);
  assert.equal(manifestBytes.includes('"absent"'), false);
  assert.equal(Object.hasOwn(manifest.metadata.prototypeKey, '__proto__'), true);
  assert.ok(manifestBytes.indexOf('"a":true') < manifestBytes.indexOf('"z":1'));
  assert.equal(readFileSync(join(source.workspace, '.pack-proof', 'sentinel'), 'utf8'), 'source-owned\n');
  assert.equal(existsSync(marker), false);
  assert.equal(git(source.workspace, ['rev-parse', 'HEAD']), baseCommitOid);
  assert.deepEqual(readFileSync(join(source.workspace, git(source.workspace, ['rev-parse', '--git-path', 'index']))), originalIndex);
  assert.equal(git(source.workspace, ['status', '--porcelain=v1', '--untracked-files=all']), statusBefore);
  rmSync(marker, { force: true });
  rmSync(source.workspace, { force: true, recursive: true });

  const destination = join(source.directory, 'restored');
  const restored = restoreCheckpoint(manifest.directory, manifest.digest, destination);
  assert.equal(restored.workspace, destination);
  assert.equal(git(destination, ['rev-parse', 'HEAD']), baseCommitOid);
  assert.equal(git(destination, ['rev-list', '--count', 'HEAD']), '2');
  assert.throws(() => git(destination, ['symbolic-ref', '-q', 'HEAD']));
  assert.deepEqual(readFileSync(join(destination, 'changed.txt')), Buffer.from('after\n'));
  assert.deepEqual(readFileSync(join(destination, 'binary.dat')), Buffer.from([0, 1, 2, 255]));
  assert.equal(lstatSync(join(destination, 'run.sh')).mode & 0o111, 0o111);
  assert.equal(readlinkSync(join(destination, 'link')), 'untracked.txt');
  assert.equal(readFileSync(join(destination, 'untracked.txt'), 'utf8'), 'kept\n');
  assert.throws(() => readFileSync(join(destination, 'deleted.txt')), { code: 'ENOENT' });
  assert.throws(() => readFileSync(join(destination, 'ignored.txt')), { code: 'ENOENT' });
  assert.equal(git(destination, ['status', '--porcelain=v1', '--untracked-files=all']).includes('changed.txt'), true);
  assert.equal(existsSync(marker), false);
});

test('refuses tampered checkpoints, redirected parents, and every existing destination', t => {
  const source = fixture(t);
  writeFileSync(join(source.workspace, 'changed.txt'), 'checkpoint\n');
  const manifest = createCheckpoint(source.workspace, source.evidence, { boundary: 'completed-turn' });

  const existing = join(source.directory, 'existing');
  mkdirSync(existing);
  writeFileSync(join(existing, 'sentinel'), 'keep\n');
  assert.throws(() => restoreCheckpoint(manifest.directory, manifest.digest, existing), /new directory|overwrite/i);
  assert.equal(readFileSync(join(existing, 'sentinel'), 'utf8'), 'keep\n');

  const outside = join(source.directory, 'outside');
  const alias = join(source.directory, 'outside-alias');
  mkdirSync(outside);
  symlinkSync(outside, alias);
  assert.throws(() => restoreCheckpoint(manifest.directory, manifest.digest, join(alias, 'restore')), /canonical|symlink|redirect/i);
  assert.equal(existsSync(join(outside, 'restore')), false);

  const wrongDigestDestination = join(source.directory, 'wrong-digest');
  assert.throws(() => restoreCheckpoint(manifest.directory, '0'.repeat(64), wrongDigestDestination), /digest/i);
  assert.equal(existsSync(wrongDigestDestination), false);

  const packPath = join(manifest.directory, 'objects.pack');
  const pack = readFileSync(packPath);
  pack[0] ^= 0xff;
  chmodSync(packPath, 0o600);
  writeFileSync(packPath, pack);
  const corruptDestination = join(source.directory, 'corrupt');
  assert.throws(() => restoreCheckpoint(manifest.directory, manifest.digest, corruptDestination), /corrupt/i);
  assert.equal(existsSync(corruptDestination), false);
});

test('failed capture publishes no checkpoint and clearly rejects submodules', t => {
  const source = fixture(t);
  const sourceAlias = join(source.directory, 'source-alias');
  const evidenceAlias = join(source.directory, 'evidence-alias');
  symlinkSync(source.workspace, sourceAlias);
  symlinkSync(source.evidence, evidenceAlias);
  assert.throws(() => createCheckpoint(sourceAlias, source.evidence, {}), /canonical|symlink/i);
  assert.throws(() => createCheckpoint(source.workspace, evidenceAlias, {}), /canonical|symlink/i);
  assert.throws(() => createCheckpoint(source.workspace, source.evidence, { oversized: 'x'.repeat(1024 * 1024 + 1) }), /metadata.*limit/i);
  assert.deepEqual(readdirSync(source.evidence), []);

  const commit = git(source.workspace, ['rev-parse', 'HEAD']);
  git(source.workspace, ['update-index', '--add', '--cacheinfo', `160000,${commit},vendor/submodule`]);
  git(source.workspace, ['commit', '-m', 'add unsupported gitlink']);
  assert.throws(() => createCheckpoint(source.workspace, source.evidence, {}), /submodule/i);
  assert.deepEqual(readdirSync(source.evidence), []);
});
