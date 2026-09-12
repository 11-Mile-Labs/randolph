import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationControls } from '../dist/delegation-control.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-control-')); const store = new Store(root);
  t.after(async () => { try { store.close(); } catch {} await rm(root, { recursive: true, force: true }); });
  store.putProject({ id: 'project', root: '/tmp/project' }); store.putConversation({ id: 'conversation', projectId: 'project' });
  store.putRun({ id: 'run', projectId: 'project', conversationId: 'conversation', status: 'completed' });
  const records = new DelegationRecords(store);
  const assignment = (id, role, dependencies) => ({ id, role, dependencies, source: 'run-basis', mode: 'read-only', task: id, harness: 'codex', executable: '/opt/codex', executableVersion: '1', model: 'model', effort: 'low', rationale: 'bounded task', deliverables: ['report'], completionCriteria: ['report completed'] });
  const plan = records.recordPlan({ runId: 'run', revision: 1, requestId: 'request', source: 'proposal', basis: { tree: 'tree' }, plan: { schemaVersion: 1, id: 'plan', revision: 1, limits: { maxWorkers: 4, maxParallel: 2, maxAttempts: 1, activeMinutes: 1 }, assignments: [assignment('worker', 'worker', []), assignment('synthesis', 'main-synthesis', ['worker'])] } });
  const input = { runId: 'run', planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest }; records.readyPlan(input);
  const authorization = records.authorize({ ...input, decision: 'user', presetSaved: false });
  let at = 1000; const controls = new DelegationControls(store, () => at);
  controls.create('run', authorization.id);
  return { root, store, records, plan, authorization, controls, advance: ms => { at += ms; }, time: () => at };
}
test('accounting charges the union of runtime and native work and retains individual durations', async t => {
  const { controls, advance } = await fixture(t);
  const prep = controls.begin('run', 1, 'prep', 'source-preparation'); advance(100);
  const native = controls.begin('run', 1, 'main', 'native-session'); advance(200);
  controls.finish('run', prep.token, { confirmed: true, evidence: { files: 'settled' } }); advance(300);
  const settled = controls.finish('run', native.token, { confirmed: true, evidence: { processes: 'gone' } });
  assert.equal(settled.spentMs, 600); assert.deepEqual(settled.activities.map(item => item.elapsedMs), [300, 500]);
  advance(5000); assert.equal(controls.tick('run').spentMs, 600);
  assert.throws(() => controls.finish('run', native.token, { confirmed: true, evidence: { processes: 'gone' } }), /stale|settled/);
});
test('pause and stop invalidate admissions while old generation activity can settle exactly once', async t => {
  const { controls, advance } = await fixture(t); const activity = controls.begin('run', 1, 'verify', 'verification');
  advance(20); const paused = controls.command('run', 1, 'pause'); assert.equal(controls.status(paused), 'pausing');
  assert.throws(() => controls.begin('run', 1, 'late', 'checkpoint'), /stale/);
  assert.throws(() => controls.begin('run', paused.generation, 'late', 'checkpoint'), /closed/);
  const stopped = controls.command('run', paused.generation, 'stop'); assert.equal(controls.status(stopped), 'stopping');
  advance(10); const settled = controls.finish('run', activity.token, { confirmed: true, evidence: { exit: true } }); assert.equal(controls.status(settled), 'stopped'); assert.equal(settled.spentMs, 30);
  assert.throws(() => controls.command('run', settled.generation, 'resume'), /Stopped/);
});
test('a tick detects exhaustion during open activity and extension preserves spent time without resuming', async t => {
  const { controls, advance } = await fixture(t); const activity = controls.begin('run', 1, 'integrate', 'integration-preparation');
  advance(60_001); const exhausted = controls.tick('run'); assert.equal(exhausted.desired, 'paused'); assert.equal(controls.status(exhausted), 'pausing');
  assert.throws(() => controls.begin('run', 1, 'late', 'checkpoint'), /stale/);
  controls.finish('run', activity.token, { confirmed: true, evidence: { files: 'settled' } });
  assert.throws(() => controls.command('run', exhausted.generation, 'resume'), /budget/);
  assert.throws(() => controls.extendBudget('run', exhausted.generation, 0), /positive/);
  const extended = controls.extendBudget('run', exhausted.generation, 30_000); assert.equal(extended.spentMs, 60_001); assert.equal(extended.budgetMs, 90_000); assert.equal(extended.desired, 'paused');
  assert.equal(controls.command('run', extended.generation, 'resume').desired, 'running');
});
test('a legitimate Stop still closes admission when its own accounting tick exhausts the budget', async t => {
  const { controls, advance } = await fixture(t); controls.begin('run', 1, 'main', 'native-session'); advance(60_001);
  const stopped = controls.command('run', 1, 'stop'); assert.equal(stopped.desired, 'stopped'); assert.equal(controls.status(stopped), 'stopping'); assert.equal(stopped.spentMs, 60_001);
});
test('uncertain cleanup closes admission but other old activities still settle honestly', async t => {
  const { controls, advance } = await fixture(t); const first = controls.begin('run', 1, 'first', 'native-session'), second = controls.begin('run', 1, 'second', 'native-session');
  advance(50); const unknown = controls.finish('run', first.token, { confirmed: false }); assert.equal(controls.status(unknown), 'interrupted');
  const settled = controls.finish('run', second.token, { confirmed: true, evidence: { processes: 'gone' } }); assert.equal(settled.activities[1].state, 'settled'); assert.equal(settled.activities[0].state, 'cleanup-unconfirmed');
  assert.throws(() => controls.command('run', settled.generation, 'resume'), /cleanup/);
  assert.throws(() => controls.finish('run', first.token, { confirmed: true, evidence: { claim: true } }), /reconciliation/);
});
test('reopen charges open work conservatively and never silently resumes active or queued work', async t => {
  const { root, store, controls, advance, time } = await fixture(t); controls.begin('run', 1, 'writer', 'native-session'); advance(2500); store.close();
  const reopened = new Store(root); const recovered = new DelegationControls(reopened, time); const [value] = recovered.reconcileOnReopen();
  assert.equal(value.spentMs, 2500); assert.equal(value.activities[0].state, 'cleanup-unconfirmed'); assert.equal(value.recoveryRequired, true); assert.equal(value.desired, 'paused');
  advance(200); assert.deepEqual(recovered.reconcileOnReopen(), [value]); assert.throws(() => recovered.begin('run', value.generation, 'replay', 'native-session'), /closed/); reopened.close();
});
test('reopen with only queued work requires an explicit recovery decision and clock rollback never refunds', async t => {
  const { controls, advance } = await fixture(t); const idle = controls.reconcileOnReopen()[0]; assert.equal(idle.recoveryRequired, true); assert.equal(idle.spentMs, 0);
  assert.throws(() => controls.command('run', idle.generation, 'resume'), /cleanup/);
  const other = await fixture(t); other.controls.begin('run', 1, 'main', 'native-session'); other.advance(100); other.controls.tick('run'); other.advance(-200);
  const rollback = other.controls.tick('run'); assert.equal(rollback.spentMs, 100); assert.equal(rollback.recoveryRequired, true); assert.equal(rollback.activities[0].state, 'cleanup-unconfirmed');
  advance(1);
});
test('current authorization, unique activity identities, evidence, and priority generations are enforced', async t => {
  const { controls, records, plan, store } = await fixture(t);
  const priority = controls.setPriority('run', 1, 8); assert.equal(priority.generation, 2); assert.throws(() => controls.begin('run', 1, 'stale', 'checkpoint'), /stale/);
  const activity = controls.begin('run', 2, 'main', 'native-session'); assert.throws(() => controls.begin('run', 2, 'main', 'native-session'), /already used/);
  assert.throws(() => controls.finish('run', activity.token, { confirmed: true }), /evidence/);
  controls.finish('run', activity.token, { confirmed: true, evidence: { exit: true } });
  records.recordPlan({ runId: 'run', revision: 2, requestId: 'request', source: 'proposal', basis: plan.basis, plan: { ...plan.plan, revision: 2 } });
  assert.throws(() => controls.begin('run', 2, 'superseded', 'checkpoint'), /current exact/);
  assert.throws(() => controls.create('run', 'foreign'), /already exists/); assert.ok(store.events('run').some(event => event.type === 'delegation.control-priority'));
});
test('activity and its event roll back together on failed persistence', async t => {
  const { controls, store } = await fixture(t); const original = store.append.bind(store);
  store.append = (run, type, ...args) => { if (type === 'delegation.control-activity-began') throw new Error('disk fault'); original(run, type, ...args); };
  assert.throws(() => controls.begin('run', 1, 'fault', 'native-session'), /disk fault/); assert.equal(controls.read('run').activities.length, 0);
  store.append = original; assert.equal(controls.begin('run', 1, 'fault', 'native-session').state, 'active');
});
