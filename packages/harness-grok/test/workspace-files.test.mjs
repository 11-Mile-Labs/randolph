import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workspaceIdentity } from '@randolph/runtime/workspace-identity';
import { WorkspaceFiles } from '../dist/workspace-files.js';

function fixture(t, executionMode = 'code') {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'randolph-files-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  fs.mkdirSync(project);
  const git = (args) =>
    execFileSync(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', project, ...args],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      },
    );
  git(['init']);
  fs.writeFileSync(join(project, 'source.txt'), 'one\ntwo\nthree');
  git(['add', 'source.txt']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'fixture',
  ]);
  const workspace = join(project, '.worktrees', 'randolph-00000000-0000-0000-0000-000000000001');
  git(['worktree', 'add', '--detach', workspace]);
  const files = new WorkspaceFiles({
    workspace,
    workspaceIdentity: workspaceIdentity(workspace),
    executionMode,
  });
  return { root, project, workspace, files, path: (name) => join(workspace, name) };
}

test('Code creates nested text and replaces worktree files without changing the source checkout', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.files.read({ path: f.path('source.txt'), line: 2, limit: 1 }), {
    content: 'two',
  });
  assert.deepEqual(f.files.write({ path: f.path('source.txt'), content: 'edited' }), {});
  f.files.write({ path: f.path('new/deep/file.txt'), content: 'created ✓' });
  assert.equal(fs.readFileSync(f.path('new/deep/file.txt'), 'utf8'), 'created ✓');
  assert.equal(fs.readFileSync(f.path('source.txt'), 'utf8'), 'edited');
  assert.equal(fs.readFileSync(join(f.project, 'source.txt'), 'utf8'), 'one\ntwo\nthree');
});

test('read-only denies writes before creating files or directories', (t) => {
  const f = fixture(t, 'read-only');
  assert.throws(() => f.files.write({ path: f.path('new/file.txt'), content: 'no' }), /read-only/i);
  assert.equal(fs.existsSync(f.path('new')), false);
  assert.equal(f.files.read({ path: f.path('source.txt') }).content, 'one\ntwo\nthree');
});

test('rejects Git metadata, traversal, relative paths and outside paths for both operations', (t) => {
  const f = fixture(t);
  for (const path of [
    f.path('.git'),
    f.path('.GIT/config'),
    f.path('nested/.GiT/config'),
    `${f.workspace}/.git/../source.txt`,
    '../source.txt',
    'source.txt',
    join(f.project, 'source.txt'),
    '/dev/fd/1',
  ]) {
    assert.throws(() => f.files.read({ path }));
    assert.throws(() => f.files.write({ path, content: 'no' }));
  }
  assert.equal(fs.existsSync(f.path('nested')), false);
});

test('rejects symlink files and ancestors including internal links and dangling links', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.path('real'));
  fs.writeFileSync(f.path('real/inside.txt'), 'inside');
  for (const [name, target] of [
    ['outside', f.project],
    ['inside', f.path('real')],
    ['linked.txt', f.path('source.txt')],
    ['dangling', join(f.root, 'missing')],
  ])
    fs.symlinkSync(target, f.path(name));
  for (const name of [
    'outside/source.txt',
    'outside/new/file.txt',
    'inside/inside.txt',
    'linked.txt',
    'dangling',
  ]) {
    assert.throws(() => f.files.read({ path: f.path(name) }));
    assert.throws(() => f.files.write({ path: f.path(name), content: 'no' }));
  }
  assert.equal(fs.existsSync(join(f.project, 'new')), false);
});

test('rejects replaced workspace roots and redirected workspace ancestors', (t) => {
  const f = fixture(t);
  fs.renameSync(f.workspace, `${f.workspace}-old`);
  fs.mkdirSync(f.workspace);
  fs.writeFileSync(f.path('source.txt'), 'replacement');
  assert.throws(() => f.files.read({ path: f.path('source.txt') }));
  assert.throws(() => f.files.write({ path: f.path('source.txt'), content: 'no' }));
  fs.rmSync(f.workspace, { recursive: true });
  fs.renameSync(`${f.workspace}-old`, f.workspace);
  const base = join(f.project, '.worktrees');
  fs.renameSync(base, `${base}-old`);
  fs.symlinkSync(`${base}-old`, base);
  assert.throws(() => f.files.read({ path: f.path('source.txt') }));
  assert.throws(() => f.files.write({ path: f.path('source.txt'), content: 'no' }));
});

test('rejects binary, invalid UTF-8, oversized, hard-linked and nonregular targets without blocking on a FIFO', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.path('binary'), Buffer.from([65, 0, 66]));
  fs.writeFileSync(f.path('invalid'), Buffer.from([0xc3, 0x28]));
  fs.writeFileSync(f.path('large'), Buffer.alloc(1_048_577, 65));
  fs.linkSync(f.path('source.txt'), f.path('hardlink'));
  fs.mkdirSync(f.path('directory'));
  execFileSync('/usr/bin/mkfifo', [f.path('fifo')]);
  for (const name of ['binary', 'invalid', 'large', 'hardlink', 'directory', 'fifo']) {
    assert.throws(() => f.files.read({ path: f.path(name) }));
    assert.throws(() => f.files.write({ path: f.path(name), content: 'no' }));
  }
  for (const content of ['a'.repeat(1_048_577), '\0', '\ud800'])
    assert.throws(() => f.files.write({ path: f.path('new/file'), content }));
  assert.equal(fs.existsSync(f.path('new')), false);
});

test('permits exactly 1 MiB and preserves executable file permissions', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.path('source.txt'), 0o751);
  f.files.write({ path: f.path('source.txt'), content: 'a'.repeat(1_048_576) });
  assert.equal(f.files.read({ path: f.path('source.txt') }).content.length, 1_048_576);
  assert.equal(fs.statSync(f.path('source.txt')).mode & 0o777, 0o751);
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), ['.git', 'source.txt']);
});

test('validates line ranges instead of accepting coerced or negative values', (t) => {
  const f = fixture(t);
  for (const range of [{ line: 0 }, { line: '1' }, { limit: -1 }, { limit: '2' }, { line: 1.5 }])
    assert.throws(() => f.files.read({ path: f.path('source.txt'), ...range }));
  assert.deepEqual(f.files.read({ path: f.path('source.txt'), line: 2, limit: 0 }), {
    content: '',
  });
});

function duringFlush(t, callback) {
  const original = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd) => {
    original(fd);
    callback();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('detects an external edit during staging and cleans its temporary file', (t) => {
  const f = fixture(t);
  duringFlush(t, () => fs.writeFileSync(f.path('source.txt'), 'external edit'));
  assert.throws(
    () => f.files.write({ path: f.path('source.txt'), content: 'agent edit' }),
    /changed/i,
  );
  assert.equal(fs.readFileSync(f.path('source.txt'), 'utf8'), 'external edit');
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), ['.git', 'source.txt']);
});

test('does not overwrite a file created externally during staging', (t) => {
  const f = fixture(t);
  duringFlush(t, () => fs.writeFileSync(f.path('new.txt'), 'external create'));
  assert.throws(
    () => f.files.write({ path: f.path('new.txt'), content: 'agent create' }),
    /changed/i,
  );
  assert.equal(fs.readFileSync(f.path('new.txt'), 'utf8'), 'external create');
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), ['.git', 'new.txt', 'source.txt']);
});

test('failed staging cleans temporary files and newly created empty directories', (t) => {
  const f = fixture(t);
  duringFlush(t, () => {
    throw new Error('disk failure');
  });
  assert.throws(
    () => f.files.write({ path: f.path('new/deep/file.txt'), content: 'agent create' }),
    /disk failure/,
  );
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), ['.git', 'source.txt']);
});

test('rejects a destination redirected during staging without touching the external target', (t) => {
  const f = fixture(t);
  duringFlush(t, () => {
    fs.unlinkSync(f.path('source.txt'));
    fs.symlinkSync(join(f.project, 'source.txt'), f.path('source.txt'));
  });
  assert.throws(() => f.files.write({ path: f.path('source.txt'), content: 'agent edit' }));
  assert.equal(fs.readFileSync(join(f.project, 'source.txt'), 'utf8'), 'one\ntwo\nthree');
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), ['.git', 'source.txt']);
});

test('rejects a parent redirected during staging and leaves outside files alone', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.path('nested'));
  fs.writeFileSync(join(f.project, 'protected.txt'), 'outside');
  duringFlush(t, () => {
    fs.renameSync(f.path('nested'), f.path('moved'));
    fs.symlinkSync(f.project, f.path('nested'));
  });
  assert.throws(() =>
    f.files.write({ path: f.path('nested/protected.txt'), content: 'agent edit' }),
  );
  assert.equal(fs.readFileSync(join(f.project, 'protected.txt'), 'utf8'), 'outside');
  assert.equal(
    fs.readdirSync(f.project).some((name) => name.startsWith('.randolph-write-')),
    false,
  );
});

test('rejects overwriting an external edit made since this boundary last read the file', (t) => {
  const f = fixture(t);
  f.files.read({ path: f.path('source.txt') });
  fs.writeFileSync(f.path('source.txt'), 'external edit after read');
  assert.throws(
    () => f.files.write({ path: f.path('source.txt'), content: 'stale agent edit' }),
    /changed/i,
  );
  assert.equal(fs.readFileSync(f.path('source.txt'), 'utf8'), 'external edit after read');
  f.files.read({ path: f.path('source.txt') });
  f.files.write({ path: f.path('source.txt'), content: 'informed agent edit' });
  assert.equal(fs.readFileSync(f.path('source.txt'), 'utf8'), 'informed agent edit');
});

for (const name of ['source.txt', 'created.txt']) {
  test(`retains the last published baseline for ${name} across subsequent writes`, (t) => {
    const f = fixture(t);
    if (name === 'source.txt') f.files.read({ path: f.path(name) });
    f.files.write({ path: f.path(name), content: 'first agent edit' });
    f.files.write({ path: f.path(name), content: 'second agent edit' });
    fs.writeFileSync(f.path(name), 'external edit after publication');
    assert.throws(
      () => f.files.write({ path: f.path(name), content: 'stale third edit' }),
      /changed/i,
    );
    assert.equal(fs.readFileSync(f.path(name), 'utf8'), 'external edit after publication');
    f.files.read({ path: f.path(name) });
    f.files.write({ path: f.path(name), content: 'informed third edit' });
    assert.equal(fs.readFileSync(f.path(name), 'utf8'), 'informed third edit');
  });
}

for (const [label, original, alias] of [
  ['filename case', 'source.txt', 'SOURCE.TXT'],
  ['directory case', 'nested/file.txt', 'NESTED/file.txt'],
  ['filename Unicode normalization', 'caf\u00e9.txt', 'cafe\u0301.txt'],
  ['directory Unicode normalization', 'caf\u00e9/file.txt', 'cafe\u0301/file.txt'],
]) {
  test(`rejects ${label} aliases instead of bypassing the last-read baseline`, (t) => {
    const f = fixture(t);
    fs.mkdirSync(join(f.path(original), '..'), { recursive: true });
    fs.writeFileSync(f.path(original), 'original');
    if (
      !fs.existsSync(f.path(alias)) ||
      fs.statSync(f.path(alias)).ino !== fs.statSync(f.path(original)).ino
    ) {
      t.skip('This filesystem does not resolve this alias.');
      return;
    }
    f.files.read({ path: f.path(original) });
    fs.writeFileSync(f.path(original), 'external edit after read');
    assert.throws(() => f.files.write({ path: f.path(alias), content: 'stale alias edit' }));
    assert.throws(() => f.files.read({ path: f.path(alias) }));
    assert.equal(fs.readFileSync(f.path(original), 'utf8'), 'external edit after read');
  });
}
