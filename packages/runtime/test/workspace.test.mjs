import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareWorkspace } from '../dist/workspace.js';

function git(root, args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

async function repository(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'randolph-workspace-test-'));
  const root = join(temporary, 'project');
  await mkdir(root);
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), '# Synthetic project\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'seed']);
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });
  return { temporary, root: realpathSync(root) };
}

test('a saved conversation workspace is rejected after symlink redirection', async (t) => {
  const { temporary, root } = await repository(t);
  const conversationId = randomUUID();
  const workspace = prepareWorkspace(root, conversationId);
  const redirected = join(temporary, 'redirected');
  await mkdir(redirected);
  git(root, ['worktree', 'remove', '--force', workspace]);
  await symlink(redirected, workspace, 'dir');

  assert.throws(
    () => prepareWorkspace(root, conversationId, workspace),
    /redirected outside its original location/,
  );
});

test('an existing registered workspace at the exact conversation path is reused after an orphaned launch', async (t) => {
  const { root } = await repository(t);
  const conversationId = randomUUID();
  const created = prepareWorkspace(root, conversationId);

  const reused = prepareWorkspace(root, conversationId);

  assert.equal(reused, created);
  const registered = git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  assert.equal(registered.filter((path) => path === created).length, 1);
});

test('worktree preparation never executes repository checkout filters', async (t) => {
  const { temporary, root } = await repository(t);
  await writeFile(join(root, '.gitattributes'), '*.md filter=probe\n');
  git(root, ['add', '.gitattributes']);
  git(root, ['commit', '-m', 'attributes']);
  const marker = join(temporary, 'filter-executed');
  git(root, ['config', 'filter.probe.smudge', `touch '${marker}'; cat`]);
  git(root, ['config', 'filter.probe.required', 'true']);
  const workspace = prepareWorkspace(root, randomUUID());
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), '# Synthetic project\n');
});

test('worktree-conditional filters cannot execute during initial checkout', async (t) => {
  const { temporary, root } = await repository(t);
  await writeFile(join(root, '.gitattributes'), '*.md filter=late\n');
  git(root, ['add', '.gitattributes']);
  git(root, ['commit', '-m', 'conditional attributes']);
  const marker = join(temporary, 'conditional-filter-executed');
  const config = join(temporary, 'conditional.gitconfig');
  await writeFile(
    config,
    `[filter "late"]\n  smudge = "touch '${marker}'; cat"\n  required = true\n`,
  );
  git(root, ['config', 'includeIf.gitdir:*/worktrees/*.path', config]);
  const workspace = prepareWorkspace(root, randomUUID());
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), '# Synthetic project\n');
});
