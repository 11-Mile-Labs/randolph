import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Runtime, Store } from '../dist/index.js';

function git(root, args) {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Recovery Fixture', '-c', 'user.email=recovery@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function hasCommit(root, oid) {
  try { git(root, ['cat-file', '-e', `${oid}^{commit}`]); return true; }
  catch { return false; }
}

async function fixture(t, { cleanupVerified = true } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'randolph-delivery-recovery-'));
  const root = join(temporary, 'project');
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Recovery Fixture']);
  git(root, ['config', 'user.email', 'recovery@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(root, 'value.txt'), 'before\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11', scripts: { test: 'fixture check' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  const seed = git(root, ['rev-parse', 'HEAD']);
  const calls = { runs: 0, checks: 0 };
  const adapter = {
    async discover() { return { available: true, authenticated: true, executable: '/fixture-codex', version: 'fixture-1', executionModes: ['read-only', 'code'], models: [{ id: 'fixture', name: 'Fixture', efforts: ['low'], defaultEffort: 'low' }] }; },
    async run(input) { calls.runs++; input.onEvent({ type: 'session.turn-started', summary: 'fixture turn established', data: { threadId: 'delivery-recovery-thread', turnId: `delivery-recovery-turn-${calls.runs}` } }); writeFileSync(join(input.workspace, 'value.txt'), 'after\n'); return { status: 'completed' }; },
    async runCommand() { calls.checks++; return { exitCode: 0, output: 'fixture passed', truncated: false, cleanupVerified }; },
  };
  const dataRoot = join(temporary, 'data');
  let runtime = new Runtime(adapter, dataRoot);
  t.after(async () => { await runtime.close(); rmSync(temporary, { recursive: true, force: true }); });
  const project = runtime.addProject(root);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const run = await runtime.send({ conversationId: conversation.id, text: 'Apply the fixture edit.' });
  const deadline = Date.now() + 2_000;
  while (runtime.hasActiveWork() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.hasActiveWork(), false);
  const review = runtime.prepareReview(conversation.id);
  return {
    root, seed, run, review, conversation, calls,
    get runtime() { return runtime; },
    async reopen() { await runtime.close(); runtime = new Runtime(adapter, dataRoot); return runtime; },
  };
}

function failExportAfterEvent(runtime, type) {
  const original = runtime.store.exportRun.bind(runtime.store);
  let injected = false;
  runtime.store.exportRun = run => {
    if (!injected && runtime.store.events(run.id).at(-1)?.type === type) {
      injected = true;
      throw new Error(`Injected export failure after ${type}`);
    }
    original(run);
  };
  return () => injected;
}

for (const boundary of ['delivery.approved', 'delivery.committed', 'delivery.merged']) {
  test(`explicit recovery after ${boundary} retains the approved commit exactly once`, { timeout: 60_000 }, async t => {
    const f = await fixture(t);
    await f.runtime.verifyReview(f.review.id);
    const wasInjected = failExportAfterEvent(f.runtime, boundary);
    await assert.rejects(f.runtime.approveReview({ reviewId: f.review.id, message: 'Approved original message' }), /Injected export failure/);
    assert.equal(wasInjected(), true);
    const interrupted = f.runtime.snapshot().reviews.find(review => review.id === f.review.id);
    assert.equal(interrupted.status, 'interrupted');
    const approvedOid = interrupted.deliveryPlan.commitOid;
    const alreadyMerged = boundary === 'delivery.merged';
    const alreadyCommitted = boundary !== 'delivery.approved';
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), alreadyMerged ? approvedOid : f.seed);
    assert.equal(hasCommit(f.root, approvedOid), alreadyCommitted);
    assert.equal(existsSync(f.run.workspace), true);

    await f.reopen();
    // Reopening may repair exports, but must not resume any delivery or harness work.
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), alreadyMerged ? approvedOid : f.seed);
    assert.equal(hasCommit(f.root, approvedOid), alreadyCommitted);
    assert.equal(existsSync(f.run.workspace), true);
    assert.deepEqual(f.calls, { runs: 1, checks: 1 });
    const recovered = await f.runtime.approveReview({ reviewId: f.review.id, message: 'Continuation cannot replace the approved message' });
    assert.equal(recovered.status, 'delivered');
    assert.equal(recovered.commitOid, approvedOid);
    assert.equal(recovered.cleaned, true);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), approvedOid);
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.seed);
    assert.equal(git(f.root, ['rev-parse', 'HEAD^{tree}']), f.review.basis.treeOid);
    assert.equal(git(f.root, ['log', '-1', '--format=%B']), 'Approved original message');
    assert.equal(readFileSync(join(f.root, 'value.txt'), 'utf8'), 'after\n');
    assert.equal(existsSync(f.run.workspace), false);
    await f.runtime.approveReview({ reviewId: f.review.id, message: 'Repeated continuation' });
    assert.equal(git(f.root, ['rev-list', '--count', 'HEAD']), '2');
    assert.deepEqual(f.calls, { runs: 1, checks: 1 });
  });
}

test('export failure cannot clear a verification cleanup quarantine', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { cleanupVerified: false });
  const wasInjected = failExportAfterEvent(f.runtime, 'verification.stop-unconfirmed');
  await assert.rejects(f.runtime.verifyReview(f.review.id), /Injected export failure/);
  assert.equal(wasInjected(), true);
  assert.equal(f.runtime.snapshot().reviews.find(review => review.id === f.review.id).status, 'stop-unconfirmed');
  await assert.rejects(f.runtime.send({ conversationId: f.conversation.id, text: 'Must remain blocked' }), /active|cleanup/i);
  await f.reopen();
  await assert.rejects(f.runtime.send({ conversationId: f.conversation.id, text: 'Still blocked' }), /active|cleanup/i);
  assert.deepEqual(f.calls, { runs: 1, checks: 1 });
});

test('schema v3 adds delegation records while preserving existing v1 history and sequence', { timeout: 60_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-migration-v1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = new DatabaseSync(join(root, 'app.sqlite'));
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, document TEXT NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), document TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), document TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), document TEXT NOT NULL);
    PRAGMA user_version=1;
  `);
  const project = { id: 'project-1', root: '/fixture/project', name: 'Existing project', createdAt: '2026-01-01' };
  const conversation = { id: 'conversation-1', projectId: project.id, title: 'Existing conversation', model: '', effort: '', createdAt: '2026-01-01', updatedAt: '2026-01-01', lastReadSequence: 7 };
  const run = { id: 'run-1', projectId: project.id, conversationId: conversation.id, status: 'completed', model: 'fixture', effort: 'low', workspace: '/fixture/project', createdAt: '2026-01-01', updatedAt: '2026-01-01', lastActivityAt: '2026-01-01' };
  const message = { id: 'message-1', conversationId: conversation.id, runId: run.id, role: 'assistant', text: 'Retained result', createdAt: '2026-01-01' };
  const event = { runId: run.id, projectId: project.id, conversationId: conversation.id, at: '2026-01-01', type: 'run.completed', summary: 'Existing result', data: {} };
  database.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(project.id, project.root, JSON.stringify(project));
  database.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run(conversation.id, project.id, JSON.stringify(conversation));
  database.prepare('INSERT INTO runs VALUES (?, ?, ?)').run(run.id, conversation.id, JSON.stringify(run));
  database.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(message.id, run.id, JSON.stringify(message));
  database.prepare('INSERT INTO events VALUES (?, ?, ?)').run(7, run.id, JSON.stringify(event));
  database.close();
  const store = new Store(root);
  try {
    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.projects, [project]);
    assert.deepEqual(snapshot.conversations, [conversation]);
    assert.deepEqual(snapshot.runs, [run]);
    assert.deepEqual(snapshot.messages, [message]);
    assert.deepEqual(snapshot.events, [{ ...event, sequence: 7 }]);
    assert.deepEqual(snapshot.reviews, []);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_controls'").get());
    store.append(run, 'fixture.after-migration', 'New event');
    assert.equal(store.events(run.id).at(-1).sequence, 8);
  } finally { store.close(); }
});

test('a fresh review permanently invalidates an unmerged approval while retaining its intent', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.runtime.verifyReview(f.review.id);
  const wasInjected = failExportAfterEvent(f.runtime, 'delivery.committed');
  await assert.rejects(f.runtime.approveReview({ reviewId: f.review.id, message: 'Earlier approved message' }), /Injected export failure/);
  assert.equal(wasInjected(), true);
  const savedPlan = f.runtime.snapshot().reviews.find(review => review.id === f.review.id).deliveryPlan;
  writeFileSync(join(f.run.workspace, 'value.txt'), 'revised after\n');
  const fresh = f.runtime.prepareReview(f.conversation.id);
  assert.notEqual(fresh.id, f.review.id);
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.verification, undefined);
  const old = f.runtime.snapshot().reviews.find(review => review.id === f.review.id);
  assert.equal(old.status, 'stale');
  assert.deepEqual(old.deliveryPlan, savedPlan);
  // Even restoring the exact old tree cannot reactivate the superseded approval.
  writeFileSync(join(f.run.workspace, 'value.txt'), 'after\n');
  await assert.rejects(f.runtime.approveReview({ reviewId: old.id, message: 'Cannot reuse' }), /fresh review/i);
  await f.reopen();
  await assert.rejects(f.runtime.approveReview({ reviewId: old.id, message: 'Still cannot reuse' }), /fresh review/i);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.seed);
  assert.equal(hasCommit(f.root, savedPlan.commitOid), true);
});

test('a merged delivery awaiting cleanup cannot be discarded by preparing a new review', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.runtime.verifyReview(f.review.id);
  const wasInjected = failExportAfterEvent(f.runtime, 'delivery.merged');
  await assert.rejects(f.runtime.approveReview({ reviewId: f.review.id, message: 'Merged approved message' }), /Injected export failure/);
  assert.equal(wasInjected(), true);
  const saved = f.runtime.snapshot().reviews.find(review => review.id === f.review.id);
  assert.throws(() => f.runtime.prepareReview(f.conversation.id), /already merged.*cleanup/i);
  assert.equal(f.runtime.snapshot().reviews.length, 1);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), saved.deliveryPlan.commitOid);
  assert.equal(existsSync(f.run.workspace), true);
  const delivered = await f.runtime.approveReview({ reviewId: f.review.id, message: 'Continue cleanup' });
  assert.equal(delivered.cleaned, true);
  assert.equal(git(f.root, ['rev-list', '--count', 'HEAD']), '2');
});
