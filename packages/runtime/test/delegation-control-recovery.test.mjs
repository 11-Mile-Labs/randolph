import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { Runtime, Store } from '../dist/index.js';

function assignment(id, role, dependencies) {
  return { id, task: `${id} task`, role, harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', model: 'fixture', effort: 'low', rationale: 'Retained fixture', dependencies, source: 'run-basis', mode: 'read-only', deliverables: ['Report'], completionCriteria: ['Report retained'] };
}
function seed(root) {
  const store = new Store(root), project = { id: 'project-one', root: '/fixture/project', name: 'Fixture', createdAt: '2026-09-12T00:00:00.000Z' }, conversation = { id: 'conversation-one', projectId: project.id, title: 'Fixture', model: 'fixture', effort: 'low', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', lastReadSequence: 0 }, run = { id: 'run-one', projectId: project.id, conversationId: conversation.id, status: 'completed', model: 'fixture', effort: 'low', workspace: '/fixture/workspace', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', lastActivityAt: '2026-09-12T00:00:00.000Z' };
  store.putProject(project); store.putConversation(conversation); store.putRun(run);
  const records = new DelegationRecords(store);
  const plan = records.recordPlan({ runId: run.id, revision: 1, requestId: 'request-one', source: 'proposal', basis: { source: 'retained' }, plan: { schemaVersion: 1, id: 'read-only-plan', revision: 1, limits: { maxWorkers: 1, maxParallel: 1, maxAttempts: 1, activeMinutes: 1 }, assignments: [assignment('worker', 'worker', []), assignment('synthesis', 'main-synthesis', ['worker'])] } });
  const ready = records.readyPlan({ runId: run.id, planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest });
  const authorization = records.authorize({ runId: run.id, planId: ready.id, digest: ready.digest, basisDigest: ready.basisDigest, decision: 'user', presetSaved: false });
  const controls = new DelegationControls(store, () => 1_000); controls.create(run.id, authorization.id); controls.begin(run.id, 1, 'prepare-source', 'source-preparation');
  assert.equal(records.sessions(run.id).length, 0); store.close(); return run;
}

test('Runtime startup quarantines an unfinished runtime-only control activity without discovering or launching', async t => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-delegation-control-recovery-')), run = seed(root), calls = { discover: 0, run: 0 };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = { async discover() { calls.discover += 1; throw new Error('Startup must not discover.'); }, async run() { calls.run += 1; throw new Error('Startup must not execute.'); } };
  const first = new Runtime(adapter, root); let firstClosed = false;
  t.after(async () => { if (!firstClosed) await first.close(); });
  const interrupted = first.snapshot().runs.find(item => item.id === run.id), control = new DelegationControls(first.store).read(run.id);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.cleanupUnconfirmed, true); assert.equal(control.recoveryRequired, true); assert.equal(control.activities[0].stage, 'source-preparation'); assert.equal(control.activities[0].state, 'cleanup-unconfirmed'); assert.deepEqual(calls, { discover: 0, run: 0 });
  await first.close(); firstClosed = true;
  const second = new Runtime(adapter, root); t.after(() => second.close());
  const persisted = second.snapshot().runs.find(item => item.id === run.id), recovered = new DelegationControls(second.store).read(run.id);
  assert.equal(persisted.status, 'interrupted'); assert.equal(persisted.cleanupUnconfirmed, true); assert.equal(recovered.recoveryRequired, true); assert.equal(recovered.activities[0].state, 'cleanup-unconfirmed'); assert.deepEqual(calls, { discover: 0, run: 0 });
});
