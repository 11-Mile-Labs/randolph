import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationChecks } from '../dist/delegation-checks.js';
import { DelegationTasks } from '../dist/delegation-tasks.js';

const origin = { version: 1, hostIdHash: 'a'.repeat(64), bootSessionId: '11111111-1111-4111-8111-111111111111' };
const assignment = (id, role, dependencies = [], source = 'run-basis', producesSource = false) => ({ id, task: `${id} task`, role, harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', model: 'fixture-model', effort: 'low', rationale: 'fixture', dependencies, source, mode: role === 'main-synthesis' || role === 'review' ? 'read-only' : 'code', deliverables: ['receipt'], completionCriteria: ['done'], ...(producesSource ? { producesSource: true } : {}) });
const source = producerTaskId => ({ checkpointDirectory: '/checkpoints/source', checkpointDigest: 'a'.repeat(64), treeOid: 'b'.repeat(40), ...(producerTaskId ? { producerTaskId } : {}) });
const workspace = { path: '/workspace/attempt', identity: { device: 12, inode: 34 } };

async function fixture(t, assignments = [assignment('worker', 'worker'), assignment('synthesis', 'main-synthesis', ['worker'])]) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-delegation-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root), at = new Date().toISOString();
  store.putProject({ id: 'project', name: 'Project', root, createdAt: at });
  store.putConversation({ id: 'conversation', projectId: 'project', title: 'Task', model: 'fixture-model', effort: 'low', createdAt: at, updatedAt: at, lastReadSequence: 0 });
  store.putRun({ id: 'run', projectId: 'project', conversationId: 'conversation', workspace: root, status: 'running', model: 'fixture-model', effort: 'low', createdAt: at, updatedAt: at, lastActivityAt: at });
  const records = new DelegationRecords(store);
  const plan = records.recordPlan({ runId: 'run', revision: 1, requestId: 'request', source: 'proposal', basis: { checkpointDigest: 'basis' }, plan: { schemaVersion: 1, id: 'plan', revision: 1, assignments, limits: { maxWorkers: 4, maxParallel: 2, maxAttempts: 2, activeMinutes: 20 } } });
  records.readyPlan({ runId: 'run', planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest });
  const authorization = records.authorize({ runId: 'run', planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest, decision: 'user', presetSaved: false });
  const taskRecords = records.createTasks({ runId: 'run', authorizationId: authorization.id });
  const controls = new DelegationControls(store); const control = controls.create('run', authorization.id);
  return { store, records, tasks: new DelegationTasks(store), controls, control, authorization, taskRecords };
}

function session(id, role = 'worker') { return { id, role, harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', model: 'fixture-model', effort: 'low', allowedTools: [], origin }; }

async function checksFixture(t) {
  const f = await fixture(t, [assignment('writer', 'worker', [], 'run-basis', true), { ...assignment('integrate', 'main-integration', ['writer'], 'output:writer', true), integrationInputs: ['writer'], repairAttempts: 0 }, assignment('verify', 'runtime-verification', ['integrate'], 'output:integrate', true), assignment('synthesis', 'main-synthesis', ['verify'], 'output:verify')]);
  // Fixture prerequisites represent already accepted writer and integration output.
  for (const prerequisite of f.taskRecords.slice(0, 2)) { prerequisite.state = 'completed'; prerequisite.attempts = [{ id: prerequisite.id + '-done', status: 'completed', cleanupConfirmed: true, result: { success: true, source: source(prerequisite.id) } }]; f.store.db.prepare('UPDATE delegation_tasks SET document=? WHERE id=?').run(JSON.stringify(prerequisite), prerequisite.id); }
  const task = f.taskRecords[2], input = { runId: 'run', taskId: task.id, attemptId: 'attempt', sessionId: 'primary', expectedGeneration: 1 };
  f.tasks.beginAttempt({ ...input, authorizationId: f.authorization.id, session: session('primary', 'verification') });
  f.tasks.bindPreparedAttempt({ ...input, source: source(f.taskRecords[1].id), contextArtifacts: [], workspace });
  const checks = new DelegationChecks(f.store);
  t.after(() => f.store.close());
  checks.initialize({ ...input, commands: [['pnpm', 'run', 'lint'], ['pnpm', 'run', 'test']] });
  return { ...f, input, checks };
}
function complete(f, claim, options = {}) {
  const input = { ...f.input, expectedGeneration: f.controls.read('run').generation, checkId: claim.check.id, sessionId: claim.session.id };
  f.checks.bindCommand({ ...input, commandId: `command-${claim.check.id}` });
  f.records.finishSession({ ...input, status: 'completed', cleanupConfirmed: true, cleanupEvidence: { group: 'gone' }, ...options.session });
  return f.checks.finishCheck({ ...input, status: 'completed', exitCode: 0, observedTreeOid: source().treeOid, ...options.check });
}

test('checks freeze one manifest, reject duplicate/out-of-order claims, and require every clean command before publication', async t => {
  const f = await checksFixture(t);
  assert.throws(() => f.checks.initialize({ ...f.input, commands: [['anything']] }), /differently/);
  assert.throws(() => f.checks.claimNext({ ...f.input, checkId: 'check-2' }), /next queued/);
  const first = f.checks.claimNext(f.input);
  assert.throws(() => f.checks.claimNext(f.input), /cannot claim/);
  complete(f, first);
  assert.equal(f.checks.passed(f.input), false);
  assert.throws(() => f.tasks.beginOutputPublication(f.input), /every|checks|verification/i);
  const second = f.checks.claimNext({ ...f.input, sessionId: 'second' });
  assert.notEqual(second.session.id, first.session.id); assert.equal(second.session.admissionClaim, undefined);
  complete(f, second);
  assert.equal(f.checks.passed(f.input), true);
  assert.deepEqual(f.records.sessions('run').map(item => item.native), [{ commandId: 'command-check-1' }, { commandId: 'command-check-2' }]);
  assert.doesNotThrow(() => f.tasks.beginOutputPublication(f.input));
});

test('Pause settles a current check, blocks the next, and Resume preserves passed check identities', async t => {
  const f = await checksFixture(t), first = f.checks.claimNext(f.input);
  f.checks.bindCommand({ ...f.input, checkId: first.check.id, commandId: 'command-check-1' });
  const paused = f.controls.command('run', 1, 'pause');
  f.records.finishSession({ ...f.input, status: 'completed', cleanupConfirmed: true, cleanupEvidence: { process: 'gone' } });
  f.checks.finishCheck({ ...f.input, checkId: first.check.id, status: 'completed', exitCode: 0, observedTreeOid: source().treeOid });
  assert.throws(() => f.checks.claimNext({ ...f.input, expectedGeneration: paused.generation, sessionId: 'second' }), /running control/);
  const resumed = f.controls.command('run', paused.generation, 'resume');
  assert.throws(() => f.checks.claimNext({ ...f.input, sessionId: 'stale' }), /stale/);
  const second = f.checks.claimNext({ ...f.input, expectedGeneration: resumed.generation, sessionId: 'second' });
  complete(f, second); assert.equal(f.checks.passed(f.input), true);
  assert.equal(f.checks.snapshot(f.input).checks[0].commandId, 'command-check-1');
});

test('an undispatched check can defer only with retained cleanup, then gets fresh cleanup and cannot forge a model turn', async t => {
  const f = await checksFixture(t), first = f.checks.claimNext(f.input);
  const input = { ...f.input, checkId: first.check.id };
  assert.throws(() => f.checks.deferCheck(input), /confirmed-cleanup/);
  f.records.finishSession({ ...input, status: 'interrupted', cleanupConfirmed: true, cleanupEvidence: { process: 'gone' } });
  f.checks.deferCheck(input);
  const again = f.checks.claimNext(f.input);
  assert.equal(again.session.cleanupConfirmed, undefined);
  assert.throws(() => f.records.bindSession({ ...input, threadId: 'fake', turnId: 'fake' }), /verification|command/i);
});

test('source-changing and unknown-cleanup checks cannot pass or release later checks; output caps preserve UTF8', async t => {
  const f = await checksFixture(t), first = f.checks.claimNext(f.input);
  const result = complete(f, first, { check: { observedTreeOid: 'c'.repeat(40), output: '𐐀'.repeat(10_000) } });
  assert.equal(result.state, 'failed'); assert.equal(f.checks.passed(f.input), false);
  assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.output) <= 16_384); assert.ok(!result.output.includes('�'));
  assert.throws(() => f.checks.claimNext({ ...f.input, sessionId: 'second' }), /cannot claim/);
  const g = await checksFixture(t), unknown = g.checks.claimNext(g.input);
  g.checks.bindCommand({ ...g.input, checkId: unknown.check.id, commandId: 'uncertain' });
  g.records.finishSession({ ...g.input, status: 'failed', cleanupConfirmed: false });
  const failure = g.checks.finishCheck({ ...g.input, checkId: unknown.check.id, status: 'failed', exitCode: null, observedTreeOid: source().treeOid });
  assert.equal(failure.state, 'cleanup-unconfirmed');
});

test('reopen quarantines unfinished checks without replay and Stop closes claims', async t => {
  const f = await checksFixture(t); f.checks.claimNext(f.input);
  f.records.reconcileUnfinishedSessions(); f.tasks.reconcileOnReopen(); f.checks.reconcileOnReopen();
  assert.equal(f.checks.snapshot(f.input).checks[0].state, 'cleanup-unconfirmed');
  assert.deepEqual(f.checks.reconcileOnReopen(), []);
  assert.throws(() => f.checks.claimNext(f.input), /closed|stale/);
  const g = await checksFixture(t); g.controls.command('run', 1, 'stop');
  assert.throws(() => g.checks.claimNext({ ...g.input, expectedGeneration: 2 }), /closed|stale/);
});
