import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixture, git, observeFixture, removeFixture } from '../src/fixture.js';

const testRoot = join(homedir(), '.cache', `randolph-fixture-tests-${randomUUID()}`);
mkdirSync(testRoot, { recursive: true });
let nextCase = 0;
const fresh = (): string => join(testRoot, `case-${nextCase++}`);
after(() => rmSync(testRoot, { recursive: true, force: true }));

test('creates bounded fixture content and baseline refs', async () => {
  const fixture = await createFixture(fresh(), join(testRoot, 'evidence'));
  try {
    assert.equal(git(fixture.worktree, ['rev-parse', 'HEAD']), fixture.baseline);
    assert.equal(observeFixture(fixture).parentHead, fixture.baseline);
    assert.match(observeFixture(fixture).remoteRefs, /refs\/heads\/main:/);
    assert.equal(readFileSync(join(fixture.worktree, 'artifact.bin')).length, 5);
    assert.equal(
      git(fixture.worktree, ['status', '--short']),
      '?? artifact.bin\n?? protected-metadata\n?? untracked.txt',
    );
  } finally {
    await removeFixture(fixture);
  }
});

test('runs the fixture regression and reports the empty-query failure', async () => {
  const fixture = await createFixture(fresh(), join(testRoot, 'evidence-2'));
  try {
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !['NODE_OPTIONS', 'NODE_V8_COVERAGE', 'NODE_TEST_CONTEXT'].includes(key),
      ),
    );
    const run = spawnSync(
      process.execPath,
      ['--test', resolve(fixture.worktree, 'test/filter.test.mjs')],
      { cwd: fixture.worktree, encoding: 'utf8', timeout: 10000, env: childEnv },
    );
    assert.equal(run.status, 1);
    const output = `${run.stdout}${run.stderr}`;
    assert.match(output, /(?:✖|not ok \d+ -) empty query returns every item/);
    assert.match(output, /(?:✔|ok \d+ -) non-empty query filters items/);
    assert.equal(
      git(fixture.worktree, ['check-ignore', 'scratch/ignored.txt']),
      'scratch/ignored.txt',
    );
  } finally {
    await removeFixture(fixture);
  }
});

test('rejects unsafe roots, including symlink ancestors, and preserves a sentinel', async () => {
  const sentinel = join(testRoot, 'sentinel.txt');
  writeFileSync(sentinel, 'keep\n');
  const repoAlias = join(testRoot, 'repo-alias');
  symlinkSync(process.cwd(), repoAlias);
  await assert.rejects(() => createFixture(join(repoAlias, 'child'), join(testRoot, 'evidence-3')));
  await assert.rejects(() =>
    createFixture(
      resolve(process.cwd(), '../../new-fixture'),
      join(testRoot, 'evidence-repository'),
    ),
  );
  await assert.rejects(() => createFixture(fresh(), resolve(process.cwd(), '../../new-evidence')));
  const tempAlias = join(testRoot, 'temp-alias');
  symlinkSync(tmpdir(), tempAlias);
  await assert.rejects(() =>
    createFixture(join(tempAlias, `child-${randomUUID()}`), join(testRoot, 'evidence-3b')),
  );
  mkdirSync(join(testRoot, 'existing'));
  await assert.rejects(() =>
    createFixture(join(testRoot, 'existing'), join(testRoot, 'evidence-4')),
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n');
});

test('rejects nested evidence and forged or replaced cleanup targets', async () => {
  const root = fresh();
  await assert.rejects(() => createFixture(root, join(root, 'evidence')));
  const fixture = await createFixture(root, join(testRoot, 'evidence-5'));
  const moved = join(testRoot, 'moved');
  try {
    await assert.rejects(() => removeFixture({ ...fixture }));
    rmSync(fixture.root, { recursive: true, force: true });
    mkdirSync(moved, { recursive: true });
    symlinkSync(moved, fixture.root);
    await assert.rejects(() => removeFixture(fixture));
    assert.equal(existsSync(moved), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});
