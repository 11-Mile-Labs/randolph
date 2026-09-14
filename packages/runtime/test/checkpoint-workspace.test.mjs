import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCheckpoint, readCheckpoint } from '../dist/checkpoint-storage.js';
import { restoreCheckpointWorktree } from '../dist/checkpoint-workspace.js';

function git(directory, args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      directory,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-checkpoint-workspace-')));
  const project = join(directory, 'project');
  const evidence = join(directory, 'evidence');
  mkdirSync(project);
  mkdirSync(evidence);
  git(project, ['init', '-b', 'main']);
  writeFileSync(join(project, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(project, '.gitattributes'), '*.txt text eol=crlf\n');
  writeFileSync(join(project, 'changed.txt'), 'base\n');
  writeFileSync(join(project, 'deleted.txt'), 'delete\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'base']);
  mkdirSync(join(project, '.worktrees'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return { directory, evidence, project };
}

test('restores a deleted checkpoint workspace under a new identity without changing its parent or siblings', (t) => {
  const paths = fixture(t);
  const oldWorkspace = join(paths.project, '.worktrees', `randolph-${randomUUID()}`);
  const sibling = join(paths.project, '.worktrees', `randolph-${randomUUID()}`);
  git(paths.project, ['worktree', 'add', '--detach', oldWorkspace, 'HEAD']);
  git(paths.project, ['worktree', 'add', '--detach', sibling, 'HEAD']);
  writeFileSync(join(sibling, 'sibling.txt'), 'untouched\n');
  const checkpointBase = git(oldWorkspace, ['rev-parse', 'HEAD']);
  writeFileSync(join(oldWorkspace, 'changed.txt'), 'raw-lf\n');
  unlinkSync(join(oldWorkspace, 'deleted.txt'));
  writeFileSync(join(oldWorkspace, 'binary.dat'), Buffer.from([0, 255, 10]));
  writeFileSync(join(oldWorkspace, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(oldWorkspace, 'run.sh'), 0o755);
  writeFileSync(join(oldWorkspace, 'untracked.txt'), 'retained\n');
  symlinkSync('untracked.txt', join(oldWorkspace, 'link'));
  const manifest = createCheckpoint(oldWorkspace, paths.evidence, { saved: true });
  assert.equal(
    readCheckpoint(manifest.directory, manifest.digest).snapshotTreeOid,
    manifest.snapshotTreeOid,
  );
  const retainedPack = readFileSync(join(manifest.directory, 'objects.pack'));
  git(paths.project, ['worktree', 'remove', '--force', oldWorkspace]);

  writeFileSync(join(paths.project, 'parent-advance.txt'), 'new parent commit\n');
  git(paths.project, ['add', 'parent-advance.txt']);
  git(paths.project, ['commit', '-m', 'advance parent']);
  const parentHead = git(paths.project, ['rev-parse', 'HEAD']);
  writeFileSync(join(paths.project, 'changed.txt'), 'operator dirty file\n');
  writeFileSync(join(paths.project, 'staged.txt'), 'operator staged file\n');
  git(paths.project, ['add', 'staged.txt']);
  const parentIndex = readFileSync(join(paths.project, '.git', 'index'));

  const workspaceId = randomUUID();
  const restored = restoreCheckpointWorktree(
    manifest.directory,
    manifest.digest,
    paths.project,
    workspaceId,
  );
  assert.equal(restored.workspace, join(paths.project, '.worktrees', `randolph-${workspaceId}`));
  assert.equal(git(restored.workspace, ['rev-parse', 'HEAD']), checkpointBase);
  assert.throws(() => git(restored.workspace, ['symbolic-ref', '-q', 'HEAD']));
  assert.deepEqual(readFileSync(join(restored.workspace, 'changed.txt')), Buffer.from('raw-lf\n'));
  assert.deepEqual(readFileSync(join(restored.workspace, 'binary.dat')), Buffer.from([0, 255, 10]));
  assert.equal(readlinkSync(join(restored.workspace, 'link')), 'untracked.txt');
  assert.equal(readFileSync(join(restored.workspace, 'untracked.txt'), 'utf8'), 'retained\n');
  assert.throws(() => readFileSync(join(restored.workspace, 'deleted.txt')), { code: 'ENOENT' });
  assert.equal(git(paths.project, ['rev-parse', 'HEAD']), parentHead);
  assert.deepEqual(readFileSync(join(paths.project, '.git', 'index')), parentIndex);
  assert.equal(readFileSync(join(paths.project, 'changed.txt'), 'utf8'), 'operator dirty file\n');
  assert.equal(readFileSync(join(sibling, 'sibling.txt'), 'utf8'), 'untouched\n');

  writeFileSync(join(restored.workspace, 'changed.txt'), 'do not overwrite\n');
  assert.throws(
    () =>
      restoreCheckpointWorktree(manifest.directory, manifest.digest, paths.project, workspaceId),
    /exists|registered|new/i,
  );
  assert.equal(readFileSync(join(restored.workspace, 'changed.txt'), 'utf8'), 'do not overwrite\n');
  assert.deepEqual(readFileSync(join(manifest.directory, 'objects.pack')), retainedPack);
});

test('blocks missing and unrelated projects without consuming or changing the checkpoint', (t) => {
  const paths = fixture(t);
  const sourceWorkspace = join(paths.project, '.worktrees', `randolph-${randomUUID()}`);
  git(paths.project, ['worktree', 'add', '--detach', sourceWorkspace, 'HEAD']);
  writeFileSync(join(sourceWorkspace, 'changed.txt'), 'saved\n');
  const manifest = createCheckpoint(sourceWorkspace, paths.evidence, { saved: true });
  const retainedManifest = readFileSync(join(manifest.directory, 'manifest.json'));
  const retainedPack = readFileSync(join(manifest.directory, 'objects.pack'));

  assert.throws(
    () =>
      restoreCheckpointWorktree(
        manifest.directory,
        manifest.digest,
        join(paths.directory, 'missing'),
        randomUUID(),
      ),
    /Restore files to a new folder first/i,
  );

  const unrelated = join(paths.directory, 'unrelated');
  mkdirSync(unrelated);
  git(unrelated, ['init', '-b', 'main']);
  writeFileSync(join(unrelated, 'other.txt'), 'unrelated\n');
  git(unrelated, ['add', '.']);
  git(unrelated, ['commit', '-m', 'unrelated']);
  mkdirSync(join(unrelated, '.worktrees'));
  const workspaceId = randomUUID();
  assert.throws(
    () => restoreCheckpointWorktree(manifest.directory, manifest.digest, unrelated, workspaceId),
    /ancestor.*Restore files to a new folder first/i,
  );
  assert.equal(git(unrelated, ['rev-parse', 'HEAD']), git(unrelated, ['rev-parse', 'main']));
  assert.throws(
    () => readFileSync(join(unrelated, '.worktrees', `randolph-${workspaceId}`, 'changed.txt')),
    { code: 'ENOENT' },
  );
  assert.deepEqual(readFileSync(join(manifest.directory, 'manifest.json')), retainedManifest);
  assert.deepEqual(readFileSync(join(manifest.directory, 'objects.pack')), retainedPack);
});

test('recreates a deleted app worktree directory under the surviving project', (t) => {
  const paths = fixture(t);
  const sourceWorkspace = join(paths.project, '.worktrees', `randolph-${randomUUID()}`);
  git(paths.project, ['worktree', 'add', '--detach', sourceWorkspace, 'HEAD']);
  writeFileSync(join(sourceWorkspace, 'changed.txt'), 'saved after workspace cleanup\n');
  const manifest = createCheckpoint(sourceWorkspace, paths.evidence, { saved: true });
  git(paths.project, ['worktree', 'remove', '--force', sourceWorkspace]);
  rmSync(join(paths.project, '.worktrees'), { recursive: true });

  const workspaceId = randomUUID();
  const restored = restoreCheckpointWorktree(
    manifest.directory,
    manifest.digest,
    paths.project,
    workspaceId,
  );
  assert.equal(restored.workspace, join(paths.project, '.worktrees', `randolph-${workspaceId}`));
  assert.equal(
    readFileSync(join(restored.workspace, 'changed.txt'), 'utf8'),
    'saved after workspace cleanup\n',
  );
});
