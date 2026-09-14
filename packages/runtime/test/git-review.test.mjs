import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  unlinkSync,
  symlinkSync,
  renameSync,
  cpSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectGitWorkspace,
  createGitReview,
  createGitDeliveryPlan,
  commitGitDelivery,
  mergeGitDelivery,
  reconcileGitDelivery,
  cleanupGitDelivery,
} from '../dist/git-review.js';

function git(path, args) {
  return execFileSync(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', path, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim();
}
function fixture(t, ignoreWorktrees = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-git-review-')));
  const root = join(base, 'project');
  const evidence = join(base, 'evidence');
  mkdirSync(root);
  mkdirSync(evidence);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), `${ignoreWorktrees ? '.worktrees/\n' : ''}ignored.txt\n`);
  writeFileSync(join(root, 'original.txt'), 'original\n');
  writeFileSync(join(root, 'removed.txt'), 'delete me\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  const workspace = join(root, '.worktrees', `randolph-${randomUUID()}`);
  git(root, ['worktree', 'add', '--detach', workspace, 'HEAD']);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { root, workspace, evidence };
}

test('review captures all nonignored file changes without altering branch, HEAD, or real index', (t) => {
  const f = fixture(t);
  const before = inspectGitWorkspace(f.root, f.workspace);
  const index = git(f.workspace, ['rev-parse', '--git-path', 'index']);
  const originalIndex = readFileSync(index);
  writeFileSync(join(f.workspace, 'original.txt'), 'changed\n');
  unlinkSync(join(f.workspace, 'removed.txt'));
  writeFileSync(join(f.workspace, 'binary.dat'), Buffer.from([0, 1, 255]));
  writeFileSync(join(f.workspace, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(f.workspace, 'run.sh'), 0o755);
  writeFileSync(join(f.workspace, 'ignored.txt'), 'not delivered');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  assert.equal(review.parentBranch, 'main');
  assert.equal(review.parentOid, before.parentOid);
  assert.equal(review.workspaceHead, before.workspaceHead);
  assert.deepEqual(review.files.map((file) => file.path).sort(), [
    'binary.dat',
    'original.txt',
    'removed.txt',
    'run.sh',
  ]);
  assert.equal(review.files.find((file) => file.path === 'binary.dat').binary, true);
  assert.match(git(f.root, ['ls-tree', review.treeOid, 'run.sh']), /^100755/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), before.parentOid);
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), before.workspaceHead);
  assert.deepEqual(readFileSync(index), originalIndex);
});

test('delivery plan is durable before effects and commit and merge reconcile without duplicate actions', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'original.txt'), 'approved result\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const plan = createGitDeliveryPlan(f.root, f.workspace, review, 'Deliver fixture');
  assert.deepEqual(reconcileGitDelivery(f.root, f.workspace, plan), {
    commitCreated: false,
    merged: false,
  });
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), review.parentOid);
  const recovered = JSON.parse(JSON.stringify(plan));
  assert.equal(commitGitDelivery(f.root, f.workspace, recovered).commitOid, plan.commitOid);
  assert.deepEqual(reconcileGitDelivery(f.root, f.workspace, plan), {
    commitCreated: true,
    merged: false,
  });
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), review.parentOid);
  mergeGitDelivery(f.root, f.workspace, recovered);
  assert.deepEqual(reconcileGitDelivery(f.root, f.workspace, plan), {
    commitCreated: true,
    merged: true,
  });
  assert.equal(readFileSync(join(f.root, 'original.txt'), 'utf8'), 'approved result\n');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), plan.commitOid);
  commitGitDelivery(f.root, f.workspace, recovered);
  mergeGitDelivery(f.root, f.workspace, recovered);
  assert.equal(git(f.root, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), review.workspaceHead);
});

test('stale worktree content and changed parent invalidate approval before commit or merge', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'original.txt'), 'reviewed\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const plan = createGitDeliveryPlan(f.root, f.workspace, review, 'Approved');
  writeFileSync(join(f.workspace, 'extra.txt'), 'not approved\n');
  assert.throws(() => commitGitDelivery(f.root, f.workspace, plan), /stale|changed/i);
  assert.equal(reconcileGitDelivery(f.root, f.workspace, plan).commitCreated, false);
  unlinkSync(join(f.workspace, 'extra.txt'));
  commitGitDelivery(f.root, f.workspace, plan);
  writeFileSync(join(f.root, 'parent.txt'), 'external change\n');
  git(f.root, ['add', '.']);
  git(f.root, ['commit', '-m', 'parent advance']);
  const advanced = git(f.root, ['rev-parse', 'HEAD']);
  assert.throws(() => mergeGitDelivery(f.root, f.workspace, plan), /stale|changed/i);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), advanced);
  assert.throws(() => createGitReview(f.root, f.workspace, f.evidence), /integration needed/i);
});

test('dirty parent changes including project settings are preserved and block delivery', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'original.txt'), 'worktree change\n');
  writeFileSync(join(f.root, 'config.harness.yaml'), 'operator-owned settings\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  assert.throws(
    () => createGitDeliveryPlan(f.root, f.workspace, review, 'Approved'),
    /parent.*uncommitted/i,
  );
  assert.equal(
    readFileSync(join(f.root, 'config.harness.yaml'), 'utf8'),
    'operator-owned settings\n',
  );
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), review.parentOid);
});

test('review fingerprints raw bytes without running clean filters or normalizing line endings', (t) => {
  const f = fixture(t);
  const marker = join(f.evidence, 'filter-executed');
  git(f.root, ['config', 'filter.bad.clean', `touch '${marker}'; cat`]);
  writeFileSync(join(f.workspace, '.gitattributes'), '*.txt filter=bad text eol=lf\n');
  writeFileSync(join(f.workspace, 'original.txt'), 'raw\r\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  assert.equal(git(f.root, ['show', `${review.treeOid}:original.txt`]), 'raw');
  assert.deepEqual(
    execFileSync('/usr/bin/git', ['-C', f.root, 'show', `${review.treeOid}:original.txt`]),
    Buffer.from('raw\r\n'),
  );
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  writeFileSync(join(f.workspace, 'original.txt'), 'raw\n');
  assert.throws(
    () => createGitDeliveryPlan(f.root, f.workspace, review, 'Approved'),
    /stale|changed/i,
  );
});

test('cleanup preserves late edits and then removes only the unchanged approved worktree idempotently', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'original.txt'), 'approved\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const plan = createGitDeliveryPlan(f.root, f.workspace, review, 'Approved');
  assert.throws(() => cleanupGitDelivery(f.root, f.workspace, plan), /merge/i);
  commitGitDelivery(f.root, f.workspace, plan);
  mergeGitDelivery(f.root, f.workspace, plan);
  writeFileSync(join(f.workspace, 'late.txt'), 'do not delete\n');
  assert.throws(() => cleanupGitDelivery(f.root, f.workspace, plan), /changed|stale/i);
  assert.equal(readFileSync(join(f.workspace, 'late.txt'), 'utf8'), 'do not delete\n');
  unlinkSync(join(f.workspace, 'late.txt'));
  writeFileSync(join(f.workspace, 'ignored.txt'), 'permitted scratch\n');
  assert.deepEqual(cleanupGitDelivery(f.root, f.workspace, plan), { cleaned: true });
  assert.throws(() => readFileSync(join(f.workspace, 'original.txt')), { code: 'ENOENT' });
  assert.deepEqual(cleanupGitDelivery(f.root, f.workspace, plan), { cleaned: true });
  assert.deepEqual(reconcileGitDelivery(f.root, f.workspace, plan), {
    commitCreated: true,
    merged: true,
  });
  assert.equal(readFileSync(join(f.root, 'original.txt'), 'utf8'), 'approved\n');
});

test('registered sibling conversation worktrees do not count as operator parent changes', (t) => {
  const f = fixture(t, false);
  const sibling = join(f.root, '.worktrees', `randolph-${randomUUID()}`);
  git(f.root, ['worktree', 'add', '--detach', sibling, 'HEAD']);
  writeFileSync(join(sibling, 'unfinished.txt'), 'independent conversation\n');
  writeFileSync(join(f.workspace, 'original.txt'), 'deliver this conversation\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const plan = createGitDeliveryPlan(f.root, f.workspace, review, 'Approved');
  writeFileSync(join(f.root, '.worktrees', 'operator.txt'), 'preserve me\n');
  assert.throws(() => commitGitDelivery(f.root, f.workspace, plan), /parent.*uncommitted/i);
  unlinkSync(join(f.root, '.worktrees', 'operator.txt'));
  commitGitDelivery(f.root, f.workspace, plan);
  mergeGitDelivery(f.root, f.workspace, plan);
  assert.equal(readFileSync(join(sibling, 'unfinished.txt'), 'utf8'), 'independent conversation\n');
});

test('redirected worktrees, detached parent and parent branch switches are refused', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'original.txt'), 'approved\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const plan = createGitDeliveryPlan(f.root, f.workspace, review, 'Approved');
  git(f.root, ['checkout', '-b', 'other']);
  assert.throws(() => commitGitDelivery(f.root, f.workspace, plan), /stale|changed/i);
  git(f.root, ['checkout', '--detach', review.parentOid]);
  assert.throws(() => inspectGitWorkspace(f.root, f.workspace), /attached branch/i);
  git(f.root, ['checkout', 'main']);
  renameSync(f.workspace, `${f.workspace}-moved`);
  symlinkSync(`${f.workspace}-moved`, f.workspace);
  assert.throws(() => commitGitDelivery(f.root, f.workspace, plan), /redirected/i);
  assert.equal(readFileSync(join(f.workspace, 'original.txt'), 'utf8'), 'approved\n');
});

test('nested repositories are rejected instead of hiding their files in a gitlink', (t) => {
  const f = fixture(t);
  const nested = join(f.workspace, 'nested');
  mkdirSync(nested);
  git(nested, ['init', '-b', 'main']);
  writeFileSync(join(nested, 'hidden.txt'), 'must not disappear');
  assert.throws(
    () => createGitReview(f.root, f.workspace, f.evidence),
    /nested|non-file|submodule/i,
  );
});

test('local delivery disables checkout filters and hooks and does not push to configured remotes', (t) => {
  const f = fixture(t);
  const marker = join(f.evidence, 'unexpected-execution');
  git(f.root, ['config', 'filter.bad.smudge', `touch '${marker}'; cat`]);
  git(f.root, ['config', 'filter.bad.required', 'true']);
  const hooks = join(f.evidence, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-merge'), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(hooks, 'post-merge'), 0o755);
  git(f.root, ['config', 'core.hooksPath', hooks]);
  git(f.root, ['remote', 'add', 'origin', join(f.evidence, 'nonexistent-remote')]);
  writeFileSync(join(f.workspace, '.gitattributes'), '*.txt filter=bad\n');
  writeFileSync(join(f.workspace, 'original.txt'), 'approved raw data\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const plan = createGitDeliveryPlan(f.root, f.workspace, review, 'Approved');
  commitGitDelivery(f.root, f.workspace, plan);
  mergeGitDelivery(f.root, f.workspace, plan);
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  assert.equal(readFileSync(join(f.root, 'original.txt'), 'utf8'), 'approved raw data\n');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), plan.commitOid);
});

test('oversized displayed diffs are explicitly truncated while their complete trees stay fingerprinted', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'large.txt'), `${'large line of changed text\n'.repeat(15000)}`);
  const review = createGitReview(f.root, f.workspace, f.evidence);
  assert.equal(review.truncated, true);
  assert.ok(Buffer.byteLength(review.diff) <= 256 * 1024);
  assert.equal(review.files.find((file) => file.path === 'large.txt').additions, 15000);
  assert.equal(
    git(f.root, ['cat-file', '-s', `${review.treeOid}:large.txt`]),
    String(Buffer.byteLength('large line of changed text\n'.repeat(15000))),
  );
});

test('replacing Git metadata at the same path invalidates existing approval even with identical commits', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'original.txt'), 'approved\n');
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const plan = createGitDeliveryPlan(f.root, f.workspace, review, 'Approved');
  const originalMetadata = join(f.evidence, 'original-git');
  renameSync(join(f.root, '.git'), originalMetadata);
  cpSync(originalMetadata, join(f.root, '.git'), { recursive: true });
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), review.parentOid);
  assert.throws(() => commitGitDelivery(f.root, f.workspace, plan), /stale|identity|changed/i);
});

test('same-length dirty parent detection never executes repository clean or process filters', (t) => {
  for (const kind of ['clean', 'process']) {
    const f = fixture(t);
    const marker = join(f.evidence, 'outside-marker');
    writeFileSync(join(f.root, '.gitattributes'), '*.txt filter=run\n');
    git(f.root, ['add', '.gitattributes']);
    git(f.root, ['commit', '-m', 'fixture attributes']);
    git(f.workspace, ['reset', '--hard', 'main']);
    git(f.root, [
      'config',
      `filter.run.${kind}`,
      `touch '${marker}'; ${kind === 'clean' ? 'cat' : 'exit 1'}`,
    ]);
    git(f.root, ['config', 'filter.run.required', 'true']);
    writeFileSync(join(f.workspace, 'original.txt'), 'approved worktree\n');
    const review = createGitReview(f.root, f.workspace, f.evidence);
    writeFileSync(join(f.root, 'original.txt'), 'changed!\n');
    assert.throws(
      () => createGitDeliveryPlan(f.root, f.workspace, review, 'Approved'),
      /uncommitted|parent/i,
    );
    assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
    assert.equal(readFileSync(join(f.root, 'original.txt'), 'utf8'), 'changed!\n');
  }
});

test('review retains exact non-UTF8 symlink target bytes', (t) => {
  const f = fixture(t);
  const target = Buffer.from([0x64, 0x69, 0x72, 0x2f, 0xff, 0xfe]);
  symlinkSync(target, join(f.workspace, 'raw-link'));
  const review = createGitReview(f.root, f.workspace, f.evidence);
  const retained = execFileSync('/usr/bin/git', [
    '-C',
    f.root,
    'show',
    `${review.treeOid}:raw-link`,
  ]);
  assert.deepEqual(retained, target);
  assert.match(git(f.root, ['ls-tree', review.treeOid, 'raw-link']), /^120000/);
});
