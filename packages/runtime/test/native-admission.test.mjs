import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeAdmission } from '../dist/native-admission.js';
import { Store } from '../dist/store.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const info = { available: true, authenticated: true, models: [], cleanupVerified: true, executable: '/fixture/codex', version: '1' };
function fixture(t, limits = { app: 1, perHarness: 1 }) {
  const root = mkdtempSync(join(tmpdir(), 'randolph-admission-')), store = new Store(root);
  const service = new NativeAdmission(store, { fixture: true }, limits);
  t.after(async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, service };
}
const context = { owner: { kind: 'app-discovery', id: 'catalog' } };

test('mixed discovery, model turn, and command share capacity; durable intent precedes invocation', async t => {
  const { service } = fixture(t); let finish; const calls = [];
  const raw = {
    discover: async () => { calls.push('discover'); assert.equal(service.records.list()[0].state, 'admitted'); await new Promise(resolve => { finish = resolve; }); return info; },
    run: async () => { calls.push('run'); return { status: 'completed' }; },
    runCommand: async () => { calls.push('command'); return { exitCode: 0, output: '', truncated: false, cleanupVerified: true }; },
  };
  const adapter = service.adapter('codex', raw, context);
  const discovery = adapter.discover(); await turn();
  const model = adapter.run({ messages: [], signal: new AbortController().signal });
  const command = adapter.runCommand({ command: ['true'], signal: new AbortController().signal }); await turn();
  assert.deepEqual(calls, ['discover']); assert.equal(service.snapshot().waiting.length, 2);
  finish(); await Promise.all([discovery, model, command]);
  assert.deepEqual(calls, ['discover', 'run', 'command']); assert.equal(service.snapshot().capacity.occupied, 0);
  assert.ok(service.records.list().every(item => item.state === 'settled'));
});

test('queued cancellation never dispatches and close awaits active discovery cleanup', async t => {
  const { service } = fixture(t); let calls = 0, finish;
  const adapter = service.adapter('codex', { discover: async (_, signal) => { calls++; await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', resolve, { once: true }); }); return info; }, run: async () => ({ status: 'completed' }) }, context);
  const first = adapter.discover(); const firstCancelled = assert.rejects(first, /cancelled/); await turn();
  const controller = new AbortController(), second = adapter.discover(undefined, controller.signal);
  const rejected = assert.rejects(second, /cancelled/); controller.abort(); await rejected;
  assert.equal(calls, 1); assert.equal(service.records.list()[1].state, 'interrupted');
  assert.equal(service.hasActiveWork(), true); await service.close(); await firstCancelled;
  assert.equal(service.hasActiveWork(), false); assert.equal(service.snapshot().capacity.occupied, 0); finish();
});

test('unknown cleanup remains occupied across reconstruction and blocks unrelated launch', async t => {
  const { service, store } = fixture(t); let calls = 0;
  const raw = { discover: async () => ({ ...info, cleanupVerified: false }), run: async () => { calls++; return { status: 'completed' }; } };
  await service.adapter('codex', raw, context).discover();
  assert.equal(service.snapshot().capacity.occupied, 1);
  const reopened = new NativeAdmission(store, {}, { app: 1, perHarness: 1 });
  const controller = new AbortController();
  const waiting = reopened.adapter('grok', raw, { owner: { kind: 'app-discovery', id: 'other' } }).run({ messages: [], signal: controller.signal });
  const rejected = assert.rejects(waiting, /cancelled/); await turn(); assert.equal(calls, 0);
  controller.abort(); await rejected; await reopened.close();
  assert.equal(reopened.snapshot().capacity.occupied, 1);
});

test('failed admission persistence launches nothing; failed settlement retains quarantine', async t => {
  const { service, store } = fixture(t); let calls = 0;
  const adapter = service.adapter('codex', { discover: async () => { calls++; return info; }, run: async () => ({ status: 'completed' }) }, context);
  store.db.exec("CREATE TRIGGER fail_admission BEFORE UPDATE ON native_operations WHEN json_extract(NEW.document, '$.state')='admitted' BEGIN SELECT RAISE(ABORT, 'admission fault'); END");
  await assert.rejects(adapter.discover(), /admission fault/); assert.equal(calls, 0); assert.equal(service.snapshot().capacity.occupied, 0);
  store.db.exec('DROP TRIGGER fail_admission');
  store.db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON native_operations WHEN json_extract(NEW.document, '$.state')='settled' BEGIN SELECT RAISE(ABORT, 'settlement fault'); END");
  await assert.rejects(adapter.discover(), /settlement fault/); assert.equal(calls, 1);
  assert.equal(service.snapshot().capacity.leases[0].state, 'cleanup-unconfirmed');
  assert.equal(service.records.list()[1].state, 'admitted');
});

test('settings or generation invalidated while queued cannot launch', async t => {
  const { service } = fixture(t); let finish, valid = true, calls = 0;
  const raw = { discover: async () => { calls++; await new Promise(resolve => { finish = resolve; }); return info; }, run: async () => ({ status: 'completed' }) };
  const first = service.adapter('codex', raw, context).discover(); await turn();
  const second = service.adapter('codex', raw, { ...context, assertCurrent: () => { if (!valid) throw new Error('stale settings'); } }).discover();
  const rejected = assert.rejects(second, /stale settings/); valid = false; finish(); await first; await rejected;
  assert.equal(calls, 1); assert.equal(service.snapshot().capacity.occupied, 0);
});

test('queued model and command requests retain their exact original input and owner', async t => {
  const { service } = fixture(t); let finish; const seen = [];
  const owner = { owner: { kind: 'app-discovery', id: 'original' } };
  const adapter = service.adapter('codex', {
    discover: async () => { await new Promise(resolve => { finish = resolve; }); return info; },
    run: async input => { seen.push(input); return { status: 'completed' }; },
    runCommand: async input => { seen.push(input); return { exitCode: 0, cleanupVerified: true, output: '', truncated: false }; },
  }, owner);
  const blocker = adapter.discover(); await turn();
  const signal = new AbortController().signal;
  const modelInput = { executable: '/approved', model: 'original', messages: [{ role: 'user', text: 'original' }], signal };
  const commandInput = { executable: '/approved', command: ['test', 'original'], signal };
  const model = adapter.run(modelInput), command = adapter.runCommand(commandInput);
  owner.owner.id = 'changed'; modelInput.executable = '/changed'; modelInput.messages[0].text = 'changed'; modelInput.model = 'changed'; commandInput.command[1] = 'changed';
  finish(); await Promise.all([blocker, model, command]);
  assert.equal(seen[0].executable, '/approved'); assert.equal(seen[0].model, 'original'); assert.equal(seen[0].messages[0].text, 'original'); assert.deepEqual(seen[1].command, ['test', 'original']);
  assert.ok(service.records.list().every(item => item.owner.id === 'original'));
});

test('cancelled discovery with unknown cleanup never claims a trusted cleanup failure', async t => {
  const { service } = fixture(t); const controller = new AbortController();
  const adapter = service.adapter('codex', { discover: async (_, signal) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { ...info, cleanupVerified: false }; }, run: async () => ({ status: 'completed' }) }, context);
  const pending = adapter.discover(undefined, controller.signal);
  const rejected = assert.rejects(pending, error => error.name === 'Error' && /cleanup could not be confirmed/.test(error.message));
  await turn(); controller.abort(); await rejected;
  assert.equal(service.records.list()[0].terminalStatus, 'interrupted'); assert.equal(service.records.list()[0].state, 'quarantined');
});

test('asynchronous authority guards cannot authorize dispatch or leak rejected promises', async t => {
  const { service } = fixture(t); let calls = 0;
  const adapter = service.adapter('codex', { discover: async () => { calls++; return info; }, run: async () => ({ status: 'completed' }) }, { ...context, assertCurrent: async () => { throw new Error('async rejection'); } });
  await assert.rejects(adapter.discover(), /must be synchronous/); await turn();
  assert.equal(calls, 0); assert.equal(service.snapshot().capacity.occupied, 0);
});

test('reopen honors queued operation proof before legacy session reconciliation', async t => {
  const { service, store } = fixture(t);
  store.putProject({ id: 'project', root: '/fixture', name: 'fixture' });
  store.putConversation({ id: 'conversation', projectId: 'project', title: 'fixture' });
  store.putRun({ id: 'run', projectId: 'project', conversationId: 'conversation', status: 'starting', harness: 'codex' });
  store.db.prepare('INSERT INTO delegation_sessions(id, run_id, document) VALUES (?, ?, ?)').run('session', 'run', JSON.stringify({ id: 'session', runId: 'run', role: 'main', state: 'dispatch-intent', harness: 'codex' }));
  service.records.create({ id: 'waiting', owner: { kind: 'run', id: 'run' }, runId: 'run', sessionId: 'session', harness: 'codex', purpose: 'model-turn', capacity: { role: 'main' }, generation: 1, origin: {} });
  const reopened = new NativeAdmission(store, {});
  assert.equal(reopened.snapshot().capacity.occupied, 0);
  const session = JSON.parse(store.db.prepare('SELECT document FROM delegation_sessions WHERE id=?').get('session').document);
  assert.equal(session.state, 'interrupted'); assert.equal(session.cleanupConfirmed, true);
  assert.equal(reopened.records.list()[0].state, 'interrupted'); await reopened.close();
});

function retainedRun(store, session) {
  store.putProject({ id: 'project', root: '/fixture', name: 'fixture' });
  store.putConversation({ id: 'conversation', projectId: 'project', title: 'fixture' });
  store.putRun({ id: 'run', projectId: 'project', conversationId: 'conversation', status: 'running', harness: 'codex' });
  if (session) store.db.prepare('INSERT INTO delegation_sessions(id, run_id, document) VALUES (?, ?, ?)').run('session', 'run', JSON.stringify({ id: 'session', runId: 'run', role: 'main', state: 'running', harness: 'codex', native: { threadId: 'thread', turnId: 'turn' } }));
}
const retainedIntent = { owner: { kind: 'run', id: 'run' }, runId: 'run', sessionId: 'session', harness: 'codex', purpose: 'model-turn', capacity: { role: 'main' }, generation: 1, origin: {} };

test('a clean discovery cannot reconcile a later unknown model turn for the same session', async t => {
  const { service, store } = fixture(t); retainedRun(store, true);
  service.records.create({ ...retainedIntent, id: 'discovery', purpose: 'discovery' }); service.records.admit({ id: 'discovery', expectedGeneration: 1 }); service.records.settle({ id: 'discovery', expectedGeneration: 1, status: 'completed', cleanupConfirmed: true, cleanupEvidence: { exited: true } });
  service.records.create({ ...retainedIntent, id: 'model' }); service.records.admit({ id: 'model', expectedGeneration: 1 });
  const reopened = new NativeAdmission(store, {});
  const session = JSON.parse(store.db.prepare('SELECT document FROM delegation_sessions WHERE id=?').get('session').document);
  assert.notEqual(session.cleanupConfirmed, true); assert.equal(reopened.snapshot().capacity.occupied, 1); await reopened.close();
});

test('new discovery intent cannot erase original legacy process quarantine', async t => {
  const { service, store } = fixture(t); retainedRun(store, false);
  const reopened = new NativeAdmission(store, {}); assert.equal(reopened.snapshot().capacity.occupied, 1);
  service.records.create({ ...retainedIntent, sessionId: undefined, id: 'new-discovery', purpose: 'discovery' });
  reopened.reconcileLegacyCleanup(); assert.equal(reopened.snapshot().capacity.occupied, 1);
  await reopened.close();
  const second = new NativeAdmission(store, {}); assert.equal(second.snapshot().capacity.occupied, 1); await second.close();
});

test('a queued no-launch operation contradicting a bound native identity fails closed', t => {
  const { service, store } = fixture(t); retainedRun(store, true);
  service.records.create({ ...retainedIntent, id: 'contradiction' });
  assert.throws(() => new NativeAdmission(store, {}), /contradicts/);
});

test('durable legacy check quarantine survives a newer queued check and another reopen', async t => {
  const { service, store } = fixture(t); retainedRun(store, false);
  store.putRun({ ...store.runs()[0], status: 'completed', cleanupUnconfirmed: false });
  store.putReview({ id: 'review', runId: 'run', conversationId: 'conversation', status: 'stop-unconfirmed', verification: { checks: [{ command: { id: 'pnpm-test' }, cleanupVerified: false }] } });
  const first = new NativeAdmission(store, {}); assert.equal(first.snapshot().capacity.occupied, 1);
  service.records.create({ ...retainedIntent, id: 'later-check', sessionId: undefined, reviewId: 'review', checkId: 'pnpm-test', purpose: 'command' });
  first.reconcileLegacyCleanup(); assert.equal(first.snapshot().capacity.occupied, 1); await first.close();
  const second = new NativeAdmission(store, {}); assert.equal(second.snapshot().capacity.occupied, 1); await second.close();
});
