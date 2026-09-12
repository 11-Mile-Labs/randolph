import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../dist/index.js';

function git(root, args) {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function settled(runtime) {
  for (let i = 0; i < 100 && runtime.hasActiveWork(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.hasActiveWork(), false);
}
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'randolph-coding-'));
  const projectRoot = join(root, 'project'); mkdirSync(projectRoot);
  git(projectRoot, ['init', '-b', 'main']);
  git(projectRoot, ['config', 'user.name', 'Fixture']); git(projectRoot, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(projectRoot, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(projectRoot, 'value.txt'), 'before\n');
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'pnpm@11.8.0', scripts: { test: 'node --test' } }));
  git(projectRoot, ['add', '.']); git(projectRoot, ['commit', '-m', 'seed']);
  const initialHead = git(projectRoot, ['rev-parse', 'HEAD']);
  const calls = [];
  const adapter = {
    async discover() { return { available: true, authenticated: true, models: [{ id: 'fixture-model', name: 'Fixture model', efforts: ['low'], defaultEffort: 'low' }], executionModes: options.readOnly ? ['read-only'] : ['read-only', 'code'] }; },
    async run(input) {
      calls.push(input);
      if (input.executionMode === 'code') writeFileSync(join(input.workspace, 'value.txt'), 'after\n');
      return { status: 'completed' };
    },
    async runCommand(input) {
      calls.push(input);
      return { exitCode: options.failedCheck ? 1 : 0, output: options.failedCheck ? 'assertion failed' : 'tests passed', truncated: false, cleanupVerified: !options.unconfirmed };
    },
  };
  const dataRoot = join(root, 'data');
  const runtime = new Runtime(adapter, dataRoot);
  const project = runtime.addProject(projectRoot);
  const conversation = runtime.createConversation(project.id);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  return { runtime, close, adapter, dataRoot, projectRoot, conversation, initialHead, calls };
}

test('Code mode requires native capability and runs only in the managed conversation worktree', async t => {
  const f = fixture(t);
  await f.runtime.setExecutionMode({ conversationId: f.conversation.id, executionMode: 'code' });
  const run = await f.runtime.send({ conversationId: f.conversation.id, text: 'Update the value.' });
  await settled(f.runtime);
  assert.equal(f.calls[0].executionMode, 'code');
  assert.notEqual(run.workspace, f.projectRoot);
  assert.equal(readFileSync(join(f.projectRoot, 'value.txt'), 'utf8'), 'before\n');
  assert.equal(readFileSync(join(run.workspace, 'value.txt'), 'utf8'), 'after\n');
  const manifest = JSON.parse(readFileSync(join(f.runtime.store.runDirectory(run), 'manifest.json'), 'utf8'));
  assert.equal(manifest.executionMode, 'code');
  assert.equal(git(f.projectRoot, ['rev-parse', 'HEAD']), f.initialHead);

  const unsupported = fixture(t, { readOnly: true });
  await assert.rejects(unsupported.runtime.setExecutionMode({ conversationId: unsupported.conversation.id, executionMode: 'code' }), /support|verified|available/i);
  assert.equal(unsupported.calls.length, 0);
});

test('review and verification leave refs unchanged; explicit approval commits and merges the exact tree', async t => {
  const f = fixture(t);
  await f.runtime.setExecutionMode({ conversationId: f.conversation.id, executionMode: 'code' });
  await f.runtime.send({ conversationId: f.conversation.id, text: 'Update the value.' });
  await settled(f.runtime);
  const review = f.runtime.prepareReview(f.conversation.id);
  assert.match(review.basis.diff, /before/); assert.match(review.basis.diff, /after/);
  assert.equal(git(f.projectRoot, ['rev-parse', 'HEAD']), f.initialHead);
  await assert.rejects(f.runtime.approveReview({ reviewId: review.id, message: 'Apply verified change' }), /check|verif/i);
  const verified = await f.runtime.verifyReview(review.id);
  assert.equal(verified.verification.status, 'passed');
  assert.equal(git(f.projectRoot, ['rev-parse', 'HEAD']), f.initialHead);
  const delivered = await f.runtime.approveReview({ reviewId: review.id, message: 'Apply verified change' });
  assert.equal(delivered.status, 'delivered');
  assert.equal(git(f.projectRoot, ['rev-parse', 'HEAD']), delivered.commitOid);
  assert.equal(readFileSync(join(f.projectRoot, 'value.txt'), 'utf8'), 'after\n');
  assert.equal(git(f.projectRoot, ['rev-parse', 'HEAD^']), f.initialHead);
  const again = await f.runtime.approveReview({ reviewId: review.id, message: 'Apply verified change' });
  assert.equal(again.commitOid, delivered.commitOid);
  assert.equal(git(f.projectRoot, ['rev-list', '--count', 'HEAD']), '2');
});

test('edits after verification invalidate approval without committing or merging', async t => {
  const f = fixture(t);
  await f.runtime.setExecutionMode({ conversationId: f.conversation.id, executionMode: 'code' });
  const run = await f.runtime.send({ conversationId: f.conversation.id, text: 'Update value.' });
  await settled(f.runtime);
  const review = f.runtime.prepareReview(f.conversation.id);
  await f.runtime.verifyReview(review.id);
  writeFileSync(join(run.workspace, 'value.txt'), 'unreviewed change\n');
  await assert.rejects(f.runtime.approveReview({ reviewId: review.id, message: 'Do not commit stale review' }), /changed|stale|match/i);
  assert.equal(git(f.projectRoot, ['rev-parse', 'HEAD']), f.initialHead);
});

test('failed checks block final approval and preserve failure evidence', async t => {
  const f = fixture(t, { failedCheck: true });
  await f.runtime.setExecutionMode({ conversationId: f.conversation.id, executionMode: 'code' });
  await f.runtime.send({ conversationId: f.conversation.id, text: 'Update value.' });
  await settled(f.runtime);
  const review = f.runtime.prepareReview(f.conversation.id);
  const checked = await f.runtime.verifyReview(review.id);
  assert.equal(checked.verification.status, 'failed');
  assert.match(checked.verification.checks[0].output, /assertion failed/);
  await assert.rejects(f.runtime.approveReview({ reviewId: review.id, message: 'Do not merge broken work' }), /check|verif/i);
  assert.equal(git(f.projectRoot, ['rev-parse', 'HEAD']), f.initialHead);
});

test('unconfirmed verification cleanup blocks further work across reopening', async t => {
  const f = fixture(t, { unconfirmed: true });
  await f.runtime.setExecutionMode({ conversationId: f.conversation.id, executionMode: 'code' });
  await f.runtime.send({ conversationId: f.conversation.id, text: 'Update value.' });
  await settled(f.runtime);
  const review = f.runtime.prepareReview(f.conversation.id);
  const checked = await f.runtime.verifyReview(review.id);
  assert.equal(checked.status, 'stop-unconfirmed');
  await assert.rejects(f.runtime.send({ conversationId: f.conversation.id, text: 'Must remain blocked' }), /active|cleanup/i);
  assert.throws(() => f.runtime.prepareReview(f.conversation.id), /active|cleanup/i);
  await f.close();
  const reopened = new Runtime(f.adapter, f.dataRoot);
  try {
    await assert.rejects(reopened.send({ conversationId: f.conversation.id, text: 'Still blocked' }), /active|cleanup/i);
    assert.equal(reopened.snapshot().reviews[0].status, 'stop-unconfirmed');
  } finally { await reopened.close(); }
  assert.equal(f.calls.length, 2);
});

test('lost run ownership persists cleanup uncertainty across repeated reopenings', async t => {
  const f = fixture(t);
  await f.runtime.send({ conversationId: f.conversation.id, text: 'Inspect' });
  await settled(f.runtime);
  const run = f.runtime.snapshot().runs[0];
  f.runtime.store.putRun({ ...run, status: 'stop-unconfirmed' });
  await f.close();
  for (let i = 0; i < 2; i++) {
    const reopened = new Runtime(f.adapter, f.dataRoot);
    try {
      await assert.rejects(reopened.send({ conversationId: f.conversation.id, text: 'Must remain blocked' }), /active|cleanup/i);
      assert.equal(reopened.snapshot().runs[0].cleanupUnconfirmed, true);
    } finally { await reopened.close(); }
  }
  assert.equal(f.calls.length, 1);
});
