import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Runtime } from '../dist/index.js';

const firstBoot = { version: 1, hostIdHash: 'a'.repeat(64), bootSessionId: '11111111-1111-4111-8111-111111111111' };
const laterBoot = { ...firstBoot, bootSessionId: '22222222-2222-4222-8222-222222222222' };
const selection = { harness: 'codex', model: 'fixture', effort: 'low' };
const response = JSON.stringify({ context: { purpose: 'Fixture project', instructions: '', documents: [] }, evidence: [], questions: [] });
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-setup-cleanup-')));
  const project = join(root, 'project'); mkdirSync(project);
  const calls = [];
  const adapter = {
    async discover() { return { available: true, authenticated: true, models: [{ id: 'fixture', name: 'Fixture', efforts: ['low'], defaultEffort: 'low' }], executionModes: ['read-only'] }; },
    async run(input) { calls.push(input); input.onEvent({ type: 'message.delta', summary: 'Proposal', data: { messageId: 'answer', text: response } }); return { status: 'completed' }; },
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
  assert.equal(result.inspections[0].canApprove, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.store.events(f.runId).filter(event => event.type === 'run.cleanup-reconciled').length, 1);
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
  f.runtime.store.append = append;
  f.runtime.reconcileProjectSetupCleanup(f.projectId);
  assert.equal(f.runtime.store.runs()[0].status, 'interrupted');
  assert.equal(f.runtime.store.runs()[0].cleanupUnconfirmed, false);
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
  release();
  const run = await pending;
  assert.throws(() => f.runtime.reconcileProjectSetupCleanup(f.projectId), /active inspection/);
  assert.equal(f.runtime.hasActiveWork(), true);
  await f.runtime.stop(run.id);
  assert.equal(f.runtime.hasActiveWork(), false);
});
