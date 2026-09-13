import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { NativeOperationRecords } from '../dist/native-operation-records.js';

const firstBoot = { version: 1, hostIdHash: 'a'.repeat(64), bootSessionId: '11111111-1111-4111-8111-111111111111' };
const laterBoot = { ...firstBoot, bootSessionId: '22222222-2222-4222-8222-222222222222' };
const selection = { harness: 'codex', model: 'fixture', effort: 'low' };
const response = JSON.stringify({ context: { purpose: 'Fixture project', instructions: '', documents: [] }, evidence: [], questions: [] });
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-setup-cleanup-')));
  const project = join(root, 'project'); mkdirSync(project);
  const calls = [];
  const adapter = {
    async discover() { return { executable: '/fixture-codex', version: 'fixture-1', available: true, authenticated: true, cleanupVerified: true, models: [{ id: 'fixture', name: 'Fixture', efforts: ['low'], defaultEffort: 'low' }], executionModes: ['read-only'] }; },
    async run(input) { calls.push(input); input.onEvent({ type: 'session.turn-started', summary: 'fixture turn established', data: { threadId: 'setup-cleanup-thread', turnId: `setup-cleanup-turn-${calls.length}` } }); input.onEvent({ type: 'message.delta', summary: 'Proposal', data: { messageId: 'answer', text: response } }); return { status: 'completed' }; },
  };
  const state = { runtime: new Runtime(adapter, join(root, 'data'), { executionOrigin: () => firstBoot }), calls, adapter };
  const registered = state.runtime.addProject(project);
  state.request = { projectId: registered.id, selection, brief: 'Inspect' };
  state.projectId = registered.id;
  state.reopen = async origin => { await state.runtime.close(); state.runtime = new Runtime(adapter, join(root, 'data'), { executionOrigin: () => origin }); };
  t.after(async () => { await state.runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const run = await state.runtime.inspectProject(state.request);
  await settle(state.runtime);
  state.runId = run.id;
  state.interrupt = (origin = firstBoot, status = 'running') => {
    const saved = state.runtime.store.runs().find(item => item.id === state.runId);
    saved.status = status; saved.executionOrigin = origin;
    state.runtime.store.putRun(saved);
    const records = new DelegationRecords(state.runtime.store);
    const session = records.sessions(state.runId)[0];
    session.state = 'cleanup-unconfirmed'; session.cleanupConfirmed = false; session.cleanupEvidence = undefined; session.error = 'Fixture simulates app ownership loss.';
    if (origin === undefined) delete session.origin; else session.origin = origin;
    state.runtime.store.db.prepare('UPDATE delegation_sessions SET document=? WHERE id=?').run(JSON.stringify(session), session.id);
    const operation = new NativeOperationRecords(state.runtime.store).list({ runId: state.runId }).find(item => item.purpose === 'model-turn' && item.sessionId === session.id);
    assert.ok(operation, 'fixture requires the main session native operation');
    operation.state = 'admitted'; delete operation.terminalStatus; delete operation.cleanupConfirmed; delete operation.cleanupEvidence;
    if (origin === undefined) delete operation.origin; else operation.origin = origin;
    state.runtime.store.db.prepare('UPDATE native_operations SET document=? WHERE id=?').run(JSON.stringify(operation), operation.id);
  };
  return state;
}
async function settle(runtime) {
  for (let i = 0; i < 100 && runtime.hasActiveWork(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.hasActiveWork(), false);
}

test('a verified later boot reconciles setup cleanup without approving or restarting old work', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.runtime.store.runs()[0].executionOrigin, firstBoot);
  f.interrupt(); await f.reopen(laterBoot);
  assert.equal(f.runtime.projectSetup(f.projectId).cleanup.canReconcile, true);
  await assert.rejects(f.runtime.inspectProject(f.request), /cleanup/);
  const result = f.runtime.reconcileProjectSetupCleanup(f.projectId);
  assert.equal(result.inspections[0].run.status, 'interrupted');
  assert.equal(result.inspections[0].run.cleanupUnconfirmed, false);
  assert.equal(new DelegationRecords(f.runtime.store).sessions(f.runId)[0].state, 'interrupted');
  assert.equal(new DelegationRecords(f.runtime.store).sessions(f.runId)[0].cleanupConfirmed, true);
  assert.equal(result.inspections[0].canApprove, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.store.events(f.runId).filter(event => event.type === 'run.cleanup-reconciled').length, 1);
  assert.equal(f.runtime.store.events(f.runId).filter(event => event.type === 'delegation.session-cleanup-reconciled').length, 1);
  await f.reopen(laterBoot);
  assert.equal(f.runtime.projectSetup(f.projectId).cleanup, undefined);
  assert.equal(new DelegationRecords(f.runtime.store).sessions(f.runId)[0].state, 'interrupted');
  f.runtime.reconcileProjectSetupCleanup(f.projectId);
  assert.equal(f.runtime.store.events(f.runId).filter(event => event.type === 'run.cleanup-reconciled').length, 1);
  await f.runtime.inspectProject(f.request); await settle(f.runtime);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.runtime.store.runs().at(-1).executionOrigin, laterBoot);
});

for (const [name, origin, current] of [
  ['same boot', firstBoot, firstBoot],
  ['copied data on another Mac', firstBoot, { ...laterBoot, hostIdHash: 'b'.repeat(64) }],
  ['legacy missing evidence', undefined, laterBoot],
  ['malformed recorded evidence', { ...firstBoot, bootSessionId: '' }, laterBoot],
  ['unavailable current identity', firstBoot, undefined],
]) {
  test(`setup cleanup stays quarantined with ${name}`, async t => {
    const f = await fixture(t); f.interrupt(origin); if (origin === undefined) {
      const run = f.runtime.store.runs()[0]; delete run.executionOrigin; f.runtime.store.putRun(run);
    }
    await f.reopen(current);
    assert.equal(f.runtime.projectSetup(f.projectId).cleanup.canReconcile, false);
    assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId));
    await assert.rejects(f.runtime.inspectProject(f.request), /cleanup/);
    await f.reopen(current);
    assert.equal(f.runtime.projectSetup(f.projectId).inspections[0].run.cleanupUnconfirmed, true);
    assert.equal(f.calls.length, 1);
  });
}

test('reconciliation transaction failure preserves quarantine and stop-unconfirmed cannot remain active after reconciliation', async t => {
  const f = await fixture(t); f.interrupt(firstBoot, 'stop-unconfirmed'); await f.reopen(laterBoot);
  const append = f.runtime.store.append.bind(f.runtime.store);
  f.runtime.store.append = (...args) => { if (args[1] === 'run.cleanup-reconciled') throw new Error('Storage unavailable'); return append(...args); };
  assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId), /Storage unavailable/);
  assert.equal(f.runtime.store.runs()[0].cleanupUnconfirmed, true);
  assert.equal(new DelegationRecords(f.runtime.store).sessions(f.runId)[0].state, 'cleanup-unconfirmed');
  f.runtime.store.append = append;
  f.runtime.reconcileProjectSetupCleanup(f.projectId);
  assert.equal(f.runtime.store.runs()[0].status, 'interrupted');
  assert.equal(f.runtime.store.runs()[0].cleanupUnconfirmed, false);
  assert.equal(new DelegationRecords(f.runtime.store).sessions(f.runId)[0].state, 'interrupted');
});

test('setup cleanup displays a retained session origin blocker and leaves it quarantined', async t => {
  const f = await fixture(t); f.interrupt();
  const session = new DelegationRecords(f.runtime.store).sessions(f.runId)[0]; delete session.origin;
  f.runtime.store.db.prepare('UPDATE delegation_sessions SET document=? WHERE id=?').run(JSON.stringify(session), session.id);
  await f.reopen(laterBoot);
  const cleanup = f.runtime.projectSetup(f.projectId).cleanup;
  assert.equal(cleanup.canReconcile, false);
  assert.match(cleanup.reason, /original Mac execution record is missing or malformed/);
  assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId), /original Mac execution record is missing or malformed/);
  assert.equal(new DelegationRecords(f.runtime.store).sessions(f.runId)[0].state, 'cleanup-unconfirmed');
});

for (const [name, change, expected] of [
  ['code mode', f => { const run = f.runtime.store.runs()[0]; run.executionMode = 'code'; f.runtime.store.putRun(run); }, /read-only project setup sessions/],
  ['worker session', f => { const session = new DelegationRecords(f.runtime.store).sessions(f.runId)[0]; session.role = 'worker'; f.runtime.store.db.prepare('UPDATE delegation_sessions SET document=? WHERE id=?').run(JSON.stringify(session), session.id); }, /worker, verification, task, or tool sessions/],
  ['application-tool receipt', f => { const session = new DelegationRecords(f.runtime.store).sessions(f.runId)[0]; f.runtime.store.db.prepare('INSERT INTO delegation_tool_receipts VALUES (?, ?, ?, ?, ?, ?, ?)').run('fixture-receipt', f.runId, session.id, 'fixture-call', '"fixture-request"', 'fixture-fingerprint', '{}'); }, /task or application-tool authority/],
]) {
  test(`setup cleanup uses the same eligibility reason for ${name}`, async t => {
    const f = await fixture(t); f.interrupt(); change(f); await f.reopen(laterBoot);
    const records = new DelegationRecords(f.runtime.store);
    const expectedReason = records.setupSessionCleanupReason(f.runId, laterBoot);
    const cleanup = f.runtime.projectSetup(f.projectId).cleanup;
    assert.match(expectedReason, expected);
    assert.equal(cleanup.reason, expectedReason);
    assert.equal(cleanup.canReconcile, false);
    assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId), expected);
  });
}

test('setup cleanup blocks retained delegation control activity with the shared eligibility reason', async t => {
  const f = await fixture(t); f.interrupt(); await f.reopen(laterBoot);
  f.runtime.store.db.exec('PRAGMA foreign_keys=OFF');
  try { f.runtime.store.db.prepare('INSERT INTO delegation_controls VALUES (?, ?, ?)').run(f.runId, 'fixture-authorization', JSON.stringify({ activities: [] })); }
  finally { f.runtime.store.db.exec('PRAGMA foreign_keys=ON'); }
  const records = new DelegationRecords(f.runtime.store);
  const expectedReason = records.setupSessionCleanupReason(f.runId, laterBoot);
  const cleanup = f.runtime.projectSetup(f.projectId).cleanup;
  assert.equal(expectedReason, 'Setup cleanup reconciliation cannot settle delegation control activity.');
  assert.throws(() => records.reconcileProjectSetupSessions(f.runId, laterBoot, false), /delegation control activity/);
  assert.equal(records.sessions(f.runId)[0].state, 'cleanup-unconfirmed');
  assert.equal(cleanup.reason, expectedReason);
  assert.equal(cleanup.canReconcile, false);
  assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId), /delegation control activity/);
});

test('cleanup reconciliation cannot interrupt inspection admission or release an owned active run', async t => {
  const f = await fixture(t);
  const discover = f.adapter.discover;
  let release;
  f.adapter.discover = async () => { await new Promise(resolve => { release = resolve; }); return discover(); };
  f.adapter.run = async input => {
    f.calls.push(input);
    await new Promise(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', resolve, { once: true }); });
    return { status: 'interrupted' };
  };
  const pending = f.runtime.inspectProject(f.request);
  assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId), /active inspection/);
  for (let i = 0; i < 100 && typeof release !== 'function'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof release, 'function');
  release();
  const run = await pending;
  assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId), /active inspection/);
  assert.equal(f.runtime.hasActiveWork(), true);
  await f.runtime.stop(run.id);
  assert.equal(f.runtime.hasActiveWork(), false);
});
