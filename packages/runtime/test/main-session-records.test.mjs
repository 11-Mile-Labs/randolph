import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { AdapterRunFailure } from '../dist/contracts.js';
import { DelegationRecords } from '../dist/delegation-records.js';

const origin = { version: 1, hostIdHash: 'a'.repeat(64), bootSessionId: '11111111-1111-4111-8111-111111111111' };

function git(project, args) {
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', project, ...args], { stdio: 'ignore' });
}

async function fixture(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-main-session-'));
  const projectRoot = join(root, 'project'); const dataRoot = join(root, 'data');
  await mkdir(projectRoot); git(projectRoot, ['init', '-b', 'main']); await writeFile(join(projectRoot, 'README.md'), 'fixture\n'); git(projectRoot, ['add', 'README.md']); git(projectRoot, ['commit', '-m', 'fixture']);
  const calls = [];
  const adapter = {
    async discover(executable) { return { executable: executable ?? '/fixture-codex', version: 'fixture-1', available: true, authenticated: true, executionModes: ['read-only'], models: [{ id: 'fixture-model', name: 'Fixture', efforts: ['low'], defaultEffort: 'low' }] }; },
    async run(input) { calls.push(input); return run(input); },
  };
  const runtime = new Runtime(adapter, dataRoot, { executionOrigin: () => origin });
  const project = runtime.addProject(projectRoot); const conversation = runtime.createConversation(project.id);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, project, conversation, calls, dataRoot, close };
}

async function settle(runtime) {
  for (let i = 0; i < 200 && runtime.hasActiveWork(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.hasActiveWork(), false);
}

function send(runtime, conversation) { return runtime.send({ conversationId: conversation.id, text: 'Record this native session.', model: 'fixture-model', effort: 'low' }); }

test('records and binds the main session only from the adapter native turn event', async t => {
  const f = await fixture(t, async input => {
    input.onEvent({ type: 'session.started', summary: 'thread established', data: { threadId: 'thread-one' } });
    input.onEvent({ type: 'session.turn-started', summary: 'turn established', data: { threadId: 'thread-one', turnId: 'turn-one' } });
    return { status: 'completed' };
  });
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  assert.equal(session.state, 'completed');
  assert.deepEqual(session.native, { threadId: 'thread-one', turnId: 'turn-one' });
  assert.deepEqual(session.origin, origin);
  assert.deepEqual([session.harness, session.executable, session.executableVersion, session.model, session.effort, session.allowedTools], ['codex', '/fixture-codex', 'fixture-1', 'fixture-model', 'low', []]);
  assert.equal('applicationTools' in f.calls[0], false);
});

test('an unknown adapter failure is retained as cleanup-unconfirmed without a fabricated identity', async t => {
  const f = await fixture(t, async () => { throw new Error('native startup failed'); });
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  const persisted = f.runtime.snapshot().runs.find(item => item.id === run.id);
  assert.equal(persisted.status, 'stop-unconfirmed');
  assert.equal(persisted.cleanupUnconfirmed, true);
  assert.equal(session.state, 'cleanup-unconfirmed');
  assert.equal(session.native, undefined);
  assert.equal(session.cleanupConfirmed, false);
  assert.match(session.error, /startup failed/);
});

test('a native adapter failure with confirmed cleanup settles the main session as failed', async t => {
  const f = await fixture(t, async input => {
    input.onEvent({ type: 'session.turn-started', summary: 'turn established', data: { threadId: 'thread-failure', turnId: 'turn-failure' } });
    throw new AdapterRunFailure('native turn failed', { processTermination: 'confirmed' });
  });
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const persisted = f.runtime.snapshot().runs.find(item => item.id === run.id);
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.cleanupUnconfirmed, undefined);
  assert.equal(session.state, 'failed');
  assert.deepEqual(session.cleanupEvidence, { processTermination: 'confirmed' });
});

test('a projection failure after confirmed session cleanup does not create cleanup uncertainty', async t => {
  const f = await fixture(t, async input => {
    input.onEvent({ type: 'session.turn-started', summary: 'turn established', data: { threadId: 'thread-projection', turnId: 'turn-projection' } });
    return { status: 'completed' };
  });
  const finish = f.runtime.finish.bind(f.runtime);
  let failOnce = true;
  f.runtime.finish = (...args) => {
    if (failOnce) { failOnce = false; throw new Error('projection receipt unavailable'); }
    return finish(...args);
  };
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const persisted = f.runtime.snapshot().runs.find(item => item.id === run.id);
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.cleanupUnconfirmed, undefined);
  assert.equal(session.state, 'completed');
  assert.equal(session.cleanupConfirmed, true);
});

test('a failure before adapter invocation retains dispatch-not-invoked cleanup evidence', async t => {
  const f = await fixture(t, async () => { throw new Error('adapter must not run'); });
  const at = new Date().toISOString();
  const run = { id: 'pre-dispatch-run', projectId: f.project.id, conversationId: f.conversation.id, status: 'starting', harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', workspace: f.project.root, workspaceIdentity: { device: 0, inode: 0 }, model: 'fixture-model', effort: 'low', executionMode: 'read-only', createdAt: at, updatedAt: at, lastActivityAt: at };
  f.runtime.store.putRun(run);
  await f.runtime.execute(run, new AbortController());
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  assert.equal(f.calls.length, 0);
  assert.equal(f.runtime.snapshot().runs.find(item => item.id === run.id).status, 'failed');
  assert.equal(session.state, 'failed');
  assert.deepEqual(session.cleanupEvidence, { dispatch: 'not-invoked' });
});

test('an interrupted adapter before native binding retains the confirmed adapter cleanup', async t => {
  const f = await fixture(t, async () => ({ status: 'interrupted' }));
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  assert.equal(f.runtime.snapshot().runs.find(item => item.id === run.id).status, 'interrupted');
  assert.equal(session.state, 'interrupted');
  assert.equal(session.native, undefined);
  assert.equal(session.cleanupConfirmed, true);
  assert.deepEqual(session.cleanupEvidence, { adapterStatus: 'interrupted' });
});

test('an unbound completed adapter fails the aggregate run and skips the completed checkpoint', async t => {
  const f = await fixture(t, async () => ({ status: 'completed' }));
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const persisted = f.runtime.snapshot().runs.find(item => item.id === run.id);
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.cleanupUnconfirmed, undefined);
  assert.equal(session.state, 'failed');
  assert.deepEqual(session.cleanupEvidence, { adapterStatus: 'completed' });
  assert.equal(persisted.checkpoints?.some(checkpoint => checkpoint.boundary === 'completed-turn'), false);
});

test('a bound stop with unconfirmed cleanup quarantines the main session', async t => {
  const f = await fixture(t, async input => {
    input.onEvent({ type: 'session.turn-started', summary: 'turn established', data: { threadId: 'thread-stop', turnId: 'turn-stop' } });
    return { status: 'stop-unconfirmed' };
  });
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const [session] = new DelegationRecords(f.runtime.store).sessions(run.id);
  assert.equal(f.runtime.snapshot().runs.find(item => item.id === run.id).status, 'stop-unconfirmed');
  assert.deepEqual(session.native, { threadId: 'thread-stop', turnId: 'turn-stop' });
  assert.equal(session.state, 'cleanup-unconfirmed');
  assert.equal(session.cleanupConfirmed, false);
  assert.equal(f.runtime.snapshot().runs.find(item => item.id === run.id).cleanupUnconfirmed, true);
});

test('duplicate identical binding is idempotent and the completed record survives reopen', async t => {
  const f = await fixture(t, async input => {
    const event = { type: 'session.turn-started', summary: 'turn established', data: { threadId: 'thread-reopen', turnId: 'turn-reopen' } };
    input.onEvent(event); input.onEvent(event);
    return { status: 'completed' };
  });
  const run = await send(f.runtime, f.conversation); await settle(f.runtime);
  const records = new DelegationRecords(f.runtime.store);
  assert.equal(records.sessions(run.id).length, 1);
  assert.equal(f.runtime.store.events(run.id).filter(event => event.type === 'delegation.session-bound').length, 1);
  await f.close();
  const reopened = new Runtime({ discover: async () => { throw new Error('must not discover on reopen'); }, run: async () => { throw new Error('must not run on reopen'); } }, f.dataRoot, { executionOrigin: () => origin });
  t.after(() => reopened.close());
  const [session] = new DelegationRecords(reopened.store).sessions(run.id);
  assert.equal(session.state, 'completed');
  assert.deepEqual(session.native, { threadId: 'thread-reopen', turnId: 'turn-reopen' });
});
