import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const { prepareIntegration, applyIntegration, reconcileSupersededDelivery } = await import(
  process.env.RANDOLPH_INTEGRATION_MODULE ?? '../dist/integration.js'
);
const { createGitReview, createGitDeliveryPlan, commitGitDelivery } = await import(
  process.env.RANDOLPH_GIT_REVIEW_MODULE ?? '../dist/git-review.js'
);
function git(root, args) {
  return execFileSync(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args],
    {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-integration-')));
  const root = join(base, 'project');
  const evidence = join(base, 'evidence');
  mkdirSync(root);
  mkdirSync(evidence);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.worktrees/\nignored.txt\n');
  writeFileSync(join(root, 'ours.txt'), 'base\n');
  writeFileSync(join(root, 'parent.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  const workspace = join(root, '.worktrees', `randolph-${randomUUID()}`);
  git(root, ['worktree', 'add', '--detach', workspace]);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { root, workspace, evidence };
}
function advance(f, name = 'parent.txt', content = 'parent advancement\n') {
  writeFileSync(join(f.root, name), content);
  git(f.root, ['add', name]);
  git(f.root, ['commit', '-m', 'parent advance']);
  return git(f.root, ['rev-parse', 'HEAD']);
}
test('integration prepares without checkout effects then preserves worktree edits over an advanced parent', (t) => {
  const f = fixture(t);
  const before = git(f.workspace, ['rev-parse', 'HEAD']);
  writeFileSync(join(f.workspace, 'ours.txt'), 'conversation edits\n');
  const parent = advance(f);
  const plan = prepareIntegration(f.root, f.workspace, f.evidence);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), before);
  assert.equal(readFileSync(join(f.workspace, 'parent.txt'), 'utf8'), 'base\n');
  const result = applyIntegration(f.root, f.workspace, JSON.parse(JSON.stringify(plan)));
  assert.equal(result.status, 'integrated');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), parent);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), parent);
  assert.equal(readFileSync(join(f.workspace, 'ours.txt'), 'utf8'), 'conversation edits\n');
  assert.equal(readFileSync(join(f.workspace, 'parent.txt'), 'utf8'), 'parent advancement\n');
  assert.equal(readFileSync(join(f.root, 'ours.txt'), 'utf8'), 'base\n');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  assert.deepEqual(
    review.files.map((file) => file.path),
    ['ours.txt'],
  );
  assert.equal(applyIntegration(f.root, f.workspace, plan).status, 'integrated');
});

test('text conflicts retain both sides and apply markers only inside the managed worktree', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'ours.txt'), 'conversation side\n');
  const parent = advance(f, 'ours.txt', 'parent side\n');
  const plan = prepareIntegration(f.root, f.workspace, f.evidence);
  assert.deepEqual(plan.conflicts, ['ours.txt']);
  assert.equal(readFileSync(join(f.workspace, 'ours.txt'), 'utf8'), 'conversation side\n');
  assert.equal(applyIntegration(f.root, f.workspace, plan).status, 'conflicted');
  const content = readFileSync(join(f.workspace, 'ours.txt'), 'utf8');
  assert.match(
    content,
    /<<<<<<<[\s\S]*conversation side[\s\S]*=======[\s\S]*parent side[\s\S]*>>>>>>>/,
  );
  assert.equal(
    readFileSync(plan.files.find((file) => file.path === 'ours.txt').before.blobPath, 'utf8'),
    'conversation side\n',
  );
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), parent);
  assert.equal(readFileSync(join(f.root, 'ours.txt'), 'utf8'), 'parent side\n');
  writeFileSync(join(f.workspace, 'ours.txt'), 'explicit resolution\n');
  assert.deepEqual(
    createGitReview(f.root, f.workspace, f.evidence).files.map((file) => file.path),
    ['ours.txt'],
  );
});

test('new edits, parent advancement and ignored path collisions refuse integration without overwriting', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'ours.txt'), 'original edits\n');
  advance(f);
  const plan = prepareIntegration(f.root, f.workspace, f.evidence);
  writeFileSync(join(f.workspace, 'ours.txt'), 'later edits\n');
  assert.throws(() => applyIntegration(f.root, f.workspace, plan), /stale|changed/i);
  assert.equal(readFileSync(join(f.workspace, 'ours.txt'), 'utf8'), 'later edits\n');
  advance(f, 'parent.txt', 'another advancement\n');
  assert.throws(() => applyIntegration(f.root, f.workspace, plan), /stale|changed/i);
  writeFileSync(join(f.workspace, 'ignored.txt'), 'operator scratch\n');
  writeFileSync(join(f.root, 'ignored.txt'), 'incoming tracked file\n');
  git(f.root, ['add', '-f', 'ignored.txt']);
  git(f.root, ['commit', '-m', 'track incoming']);
  assert.throws(() => prepareIntegration(f.root, f.workspace, f.evidence), /ignored|unrelated/i);
  assert.equal(readFileSync(join(f.workspace, 'ignored.txt'), 'utf8'), 'operator scratch\n');
});

test('Git ref-lock failure restores original working files and staging while retaining evidence', (t) => {
  const f = fixture(t);
  const originalHead = git(f.workspace, ['rev-parse', 'HEAD']);
  writeFileSync(join(f.workspace, 'ours.txt'), 'staged edit\n');
  git(f.workspace, ['add', 'ours.txt']);
  writeFileSync(join(f.workspace, 'ours.txt'), 'unstaged edit\n');
  advance(f);
  const plan = prepareIntegration(f.root, f.workspace, f.evidence);
  const index = readFileSync(plan.indexPath);
  writeFileSync(
    `${git(f.workspace, ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'])}.lock`,
    'external lock',
  );
  assert.throws(() => applyIntegration(f.root, f.workspace, plan), /lock|Git operation/i);
  assert.equal(readFileSync(join(f.workspace, 'ours.txt'), 'utf8'), 'unstaged edit\n');
  assert.equal(readFileSync(join(f.workspace, 'parent.txt'), 'utf8'), 'base\n');
  assert.deepEqual(readFileSync(plan.indexPath), index);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), originalHead);
  assert.ok(readFileSync(plan.originalIndexPath).length);
});

test('custom merge drivers and dirty parent files are rejected without executing repository commands', (t) => {
  const f = fixture(t);
  advance(f);
  const marker = join(f.evidence, 'driver-executed');
  git(f.root, ['config', 'merge.custom.driver', `touch '${marker}'`]);
  assert.throws(() => prepareIntegration(f.root, f.workspace, f.evidence), /custom.*driver/i);
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  git(f.root, ['config', '--unset', 'merge.custom.driver']);
  writeFileSync(join(f.root, 'parent.txt'), 'dirty parent\n');
  assert.throws(() => prepareIntegration(f.root, f.workspace, f.evidence), /uncommitted/i);
  assert.equal(readFileSync(join(f.root, 'parent.txt'), 'utf8'), 'dirty parent\n');
});

test('supersession reconciliation allows integrated workspace HEAD while reporting the original commit outcome', (t) => {
  for (const mergeOriginal of [false, true]) {
    const f = fixture(t);
    writeFileSync(join(f.workspace, 'ours.txt'), 'approved edits\n');
    const review = createGitReview(f.root, f.workspace, f.evidence);
    const delivery = createGitDeliveryPlan(f.root, f.workspace, review, 'original approval');
    commitGitDelivery(f.root, f.workspace, delivery);
    if (mergeOriginal) git(f.root, ['merge', '--ff-only', delivery.commitOid]);
    advance(f);
    const integration = prepareIntegration(f.root, f.workspace, f.evidence);
    applyIntegration(f.root, f.workspace, integration);
    assert.notEqual(git(f.workspace, ['rev-parse', 'HEAD']), delivery.review.workspaceHead);
    assert.deepEqual(reconcileSupersededDelivery(f.root, f.workspace, delivery), {
      commitCreated: true,
      merged: mergeOriginal,
    });
    git(f.root, ['checkout', '-b', 'different-target']);
    assert.throws(
      () => reconcileSupersededDelivery(f.root, f.workspace, delivery),
      /identity|target|stale/i,
    );
  }
});

test('rollback preserves an external edit detected after applying integration', (t) => {
  const f = fixture(t);
  const initialHead = git(f.workspace, ['rev-parse', 'HEAD']);
  writeFileSync(join(f.workspace, 'ours.txt'), 'conversation edits\n');
  advance(f);
  const plan = prepareIntegration(f.root, f.workspace, f.evidence);
  const fs = createRequire(import.meta.url)('node:fs');
  const originalRename = fs.renameSync;
  const mocked = mock.method(fs, 'renameSync', (source, target) => {
    if (source === `${plan.indexPath}.lock` && target === plan.indexPath) {
      writeFileSync(join(f.workspace, 'parent.txt'), 'external concurrent edit\n');
      throw new Error('simulated index installation failure');
    }
    return originalRename(source, target);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyIntegration(f.root, f.workspace, plan), /incomplete rollback/i);
    assert.equal(
      readFileSync(join(f.workspace, 'parent.txt'), 'utf8'),
      'external concurrent edit\n',
    );
    assert.equal(readFileSync(join(f.workspace, 'ours.txt'), 'utf8'), 'conversation edits\n');
    assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), initialHead);
    assert.equal(
      readFileSync(plan.files.find((file) => file.path === 'parent.txt').before.blobPath, 'utf8'),
      'base\n',
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('replaced retained blobs cannot redirect or enlarge integration input on apply', (t) => {
  const f = fixture(t);
  advance(f);
  const plan = prepareIntegration(f.root, f.workspace, f.evidence);
  const entry = plan.files[0].after;
  const external = join(f.evidence, 'outside-blob');
  writeFileSync(external, readFileSync(entry.blobPath));
  unlinkSync(entry.blobPath);
  symlinkSync(external, entry.blobPath);
  assert.throws(() => applyIntegration(f.root, f.workspace, plan), /linked|nonregular|redirect/i);
  assert.equal(readFileSync(join(f.workspace, 'parent.txt'), 'utf8'), 'base\n');
  unlinkSync(entry.blobPath);
  writeFileSync(entry.blobPath, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => applyIntegration(f.root, f.workspace, plan), /oversized/i);
  assert.equal(readFileSync(join(f.workspace, 'parent.txt'), 'utf8'), 'base\n');
});
