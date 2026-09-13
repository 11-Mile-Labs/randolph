import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { Checkpoints } from '../dist/checkpoints.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationTasks } from '../dist/delegation-tasks.js';
import { DelegationVerificationExecutor } from '../dist/delegation-verification.js';
import { DelegationChecks } from '../dist/delegation-checks.js';
import { workspaceIdentity } from '../dist/workspace-identity.js';
import { WorkspaceLeases } from '../dist/workspace-leases.js';
import { NativeAdmission } from '../dist/native-admission.js';
import { prepareWorkspace } from '../dist/workspace.js';

const selection = { harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', model: 'fixture', effort: 'low' };
const info = { executable: selection.executable, version: selection.executableVersion, available: true, authenticated: true, cleanupVerified: true, models: [{ id: 'fixture', efforts: ['low'] }], executionModes: ['read-only', 'code'], commandLifecycle: true };
function git(root, ...args) { return execFileSync('/usr/bin/git', ['-c', 'init.templateDir=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8' }).trim(); }
function fixture(t, clock) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-native-task-'))), projectRoot = join(root, 'project'); mkdirSync(projectRoot);
  git(projectRoot, 'init', '-b', 'main'); writeFileSync(join(projectRoot, 'source.txt'), 'retained source'); writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { lint: 'echo lint', test: 'echo test' } })); git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-m', 'fixture');
  const store = new Store(join(root, 'data')), records = new DelegationRecords(store), controls = new DelegationControls(store, clock), tasks = new DelegationTasks(store);
  const conversationId = randomUUID(), workspace = prepareWorkspace(projectRoot, conversationId);
  const run = { createdAt: '2026-09-12T00:00:00.000Z', ...selection, id: 'run', projectId: 'project', conversationId, status: 'completed', workspace, enabledHarnessRoutes: [{ harness: 'codex', executable: selection.executable }] };
  store.putProject({ id: 'project', root: projectRoot }); store.putConversation({ id: conversationId, projectId: 'project' }); store.putRun(run); mkdirSync(store.runDirectory(run), { recursive: true });
  const checkpoint = new Checkpoints(store).capture(run, 'completed-turn');
  const assignment = (id, role, dependencies, source = 'run-basis', extra = {}) => ({ ...selection, id, role, dependencies, source, mode: role === 'main-synthesis' ? 'read-only' : 'code', ...extra, task: id, rationale: 'bounded work', deliverables: ['report'], completionCriteria: ['report retained'] });
  const plan = records.recordPlan({ runId: run.id, revision: 1, requestId: 'request', source: 'proposal', basis: { checkpointDigest: checkpoint.digest, sourceTreeOid: checkpoint.snapshotTreeOid }, plan: { schemaVersion: 1, id: 'plan', revision: 1, limits: { maxWorkers: 1, maxParallel: 1, maxAttempts: 1, activeMinutes: 1 }, assignments: [assignment('worker', 'worker', [], 'run-basis', { producesSource: true }), assignment('integrate', 'main-integration', ['worker'], 'output:worker', { producesSource: true, integrationInputs: ['worker'], repairAttempts: 0 }), assignment('verify', 'runtime-verification', ['integrate'], 'output:integrate', { producesSource: true }), assignment('synthesis', 'main-synthesis', ['verify'], 'output:verify')] } });
  const revision = { runId: run.id, planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest }; records.readyPlan(revision);
  const auth = records.authorize({ ...revision, decision: 'user', presetSaved: false }); records.createTasks({ runId: run.id, authorizationId: auth.id }); controls.create(run.id, auth.id);
  const initial = records.tasks(run.id), producer = initial.find(item => item.assignmentId === 'integrate');
  const source = { checkpointDirectory: checkpoint.directory, checkpointDigest: checkpoint.digest, treeOid: checkpoint.snapshotTreeOid, producerTaskId: producer.id };
  for (const task of initial.filter(item => ['worker', 'integrate'].includes(item.assignmentId))) { task.state = 'completed'; task.attempts = [{ id: task.id + '-done', status: 'completed', cleanupConfirmed: true, result: { success: true, source: { ...source, producerTaskId: task.id } } }]; store.db.prepare('UPDATE delegation_tasks SET document=? WHERE id=?').run(JSON.stringify(task), task.id); }
  const task = records.tasks(run.id).find(item => item.assignmentId === 'verify'), attemptId = randomUUID(), sessionId = randomUUID();
  const input = { runId: run.id, taskId: task.id, attemptId, sessionId, expectedGeneration: 1, messages: [{ role: 'user', text: 'Inspect source.txt and report.' }], signal: new AbortController().signal };
  tasks.beginAttempt({ ...input, authorizationId: auth.id, session: { ...selection, id: sessionId, role: 'verification', allowedTools: [], origin: { fixture: true } } });
  const prepared = { workspace, workspaceIdentity: workspaceIdentity(workspace), source };
  tasks.bindPreparedAttempt({ ...input, source: prepared.source, workspace: { path: prepared.workspace, identity: prepared.workspaceIdentity }, contextArtifacts: [] });
  const admission = new NativeAdmission(store, { fixture: true }), queue = admission.queue, capacity = queue.capacity, leases = new WorkspaceLeases();
  const ownership = leases.acquire({ reservationId: attemptId, runId: run.id, workspace: prepared.workspace });
  input.workspaceLease = { reservationId: attemptId, generation: ownership.lease.generation };
  t.after(() => { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { store, records, controls, tasks, input, prepared, admission, capacity, queue, leases, run, auth, checks: new DelegationChecks(store) };
}
function adapter(overrides = {}) {
  return { async discover() { return info; }, async run() { throw new Error('Checks cannot invoke a model turn.'); }, async runCommand(input) { input.onDispatch({ processId: randomUUID() }); input.onOutput('check output'); return { exitCode: 0, output: 'check output', cleanupVerified: true, truncated: false }; }, ...overrides };
}
const executor = (f, value) => new DelegationVerificationExecutor(f.store, f.controls, f.admission, f.leases, () => value ?? adapter());

test('native verification runs one exact command per admission, retains all identities, and completes only after all checks', async t => {
  const f = fixture(t), seen = [];
  const native = executor(f, adapter({ async runCommand(input) { seen.push(input); return adapter().runCommand(input); } }));
  assert.equal((await native.runNext(f.input)).status, 'next-check');
  assert.equal(f.checks.passed(f.input), false);
  assert.equal((await native.runNext(f.input)).status, 'passed');
  assert.deepEqual(seen.map(value => value.command), [['pnpm', 'run', 'lint'], ['pnpm', 'run', 'test']]);
  assert.ok(seen.every(value => value.executable === selection.executable && value.executableVersion === selection.executableVersion));
  assert.equal(new Set(f.records.sessions('run').map(value => value.native.commandId)).size, 2);
  assert.equal(f.capacity.snapshot().occupied, 0);
  assert.equal(f.controls.read('run').activities.length, 6); assert.ok(f.controls.read('run').activities.every(value => value.state === 'settled'));
  assert.equal((await native.runNext(f.input)).status, 'passed'); assert.equal(seen.length, 2);
});

test('Pause during a check keeps its pass; explicit Resume runs only the next check', async t => {
  const f = fixture(t); let calls = 0;
  const native = executor(f, adapter({ async runCommand(input) { calls++; const result = await adapter().runCommand(input); f.controls.command('run', f.controls.read('run').generation, 'pause'); return result; } }));
  assert.equal((await native.runNext(f.input)).status, 'next-check');
  assert.throws(() => f.tasks.assertRuntimeStage({ ...f.input, expectedGeneration: 2 }), /running control/);
  const resumed = f.controls.command('run', 2, 'resume');
  assert.equal((await native.runNext({ ...f.input, expectedGeneration: resumed.generation })).status, 'passed'); assert.equal(calls, 2);
});

test('Pause during discovery defers the undispatched command with cleanup; Resume reclaims without stale evidence', async t => {
  const f = fixture(t); let discoveries = 0, calls = 0;
  const native = executor(f, adapter({ async discover() { if (!discoveries++) f.controls.command('run', 1, 'pause'); return info; }, async runCommand(input) { calls++; return adapter().runCommand(input); } }));
  assert.equal((await native.runNext(f.input)).status, 'pending'); assert.equal(calls, 0); assert.equal(f.capacity.snapshot().occupied, 0);
  assert.equal(f.checks.snapshot(f.input).checks[0].state, 'queued');
  const resumed = f.controls.command('run', 2, 'resume');
  assert.equal((await native.runNext({ ...f.input, expectedGeneration: resumed.generation })).status, 'next-check'); assert.equal(calls, 1);
});

test('concurrent executors cannot dispatch or settle the same command twice', async t => {
  const f = fixture(t); let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const value = adapter({ async discover() { began(); return await new Promise(resolve => { release = () => resolve(info); }); } });
  const first = executor(f, value).runNext(f.input); await started;
  const duplicate = await executor(f, value).runNext(f.input); assert.equal(duplicate.status, 'failed'); assert.match(duplicate.error, /cannot claim/);
  assert.equal(f.records.sessions('run')[0].state, 'prepared');
  release(); assert.equal((await first).status, 'next-check'); assert.equal(f.capacity.snapshot().occupied, 0);
});

test('missing command capability and command identity are failures without model or fallback execution', async t => {
  const f = fixture(t); let called = false;
  const unavailable = await executor(f, adapter({ async discover() { return { ...info, commandLifecycle: false }; }, async runCommand() { called = true; } })).runNext(f.input);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(called, false); assert.equal(f.checks.snapshot(f.input).checks[0].state, 'unavailable');
  const g = fixture(t);
  const missing = await executor(g, adapter({ async runCommand() { return { exitCode: 0, output: '', truncated: false, cleanupVerified: true }; } })).runNext(g.input);
  assert.equal(missing.status, 'failed'); assert.equal(g.checks.passed(g.input), false); assert.equal(g.records.sessions('run')[0].native, undefined);
});

test('a check that changes eligible source fails and blocks later checks', async t => {
  const f = fixture(t);
  const native = executor(f, adapter({ async runCommand(input) { const result = await adapter().runCommand(input); writeFileSync(join(input.workspace, 'source.txt'), 'changed'); return result; } }));
  assert.equal((await native.runNext(f.input)).status, 'failed'); assert.equal(f.checks.snapshot(f.input).checks[0].state, 'failed');
  assert.equal((await native.runNext(f.input)).status, 'failed');
});

test('unknown command cleanup retains capacity quarantine and rejects later work', async t => {
  const f = fixture(t);
  const result = await executor(f, adapter({ async runCommand(input) { const result = await adapter().runCommand(input); return { ...result, cleanupVerified: false }; } })).runNext(f.input);
  assert.equal(result.cleanupConfirmed, false); assert.equal(f.capacity.snapshot().occupied, 1); assert.equal(f.checks.snapshot(f.input).checks[0].state, 'cleanup-unconfirmed');
  await assert.rejects(executor(f).runNext(f.input), /closed/);
});

test('Stop invalidates a command during native startup before its dispatch callback', async t => {
  const f = fixture(t); let dispatched = false;
  const result = await executor(f, adapter({ async runCommand(input) { f.controls.command('run', 1, 'stop'); try { input.onDispatch({ processId: 'must-not-dispatch' }); dispatched = true; } catch { return { exitCode: null, output: '', truncated: false, cleanupVerified: true, error: 'stopped before command' }; } } })).runNext(f.input);
  assert.equal(result.status, 'failed'); assert.equal(dispatched, false); assert.equal(f.capacity.snapshot().occupied, 0);
});

test('shared deadline prevents command binding during cleanup grace and late results cannot clear quarantine', async t => {
  const f = fixture(t); let raw, late, graceRejected = false;
  const perform = f.admission.perform.bind(f.admission);
  f.admission.perform = (harness, context, purpose, ...args) => perform(harness, { ...context, ...(purpose === 'command' ? { timeoutMs: 10, cleanupTimeoutMs: 10 } : {}) }, purpose, ...args);
  const result = await executor(f, adapter({ async runCommand(input) {
    raw = input;
    input.signal.addEventListener('abort', () => { assert.throws(() => input.onDispatch({ processId: 'after-deadline' }), /late or duplicated/); graceRejected = true; }, { once: true });
    return await new Promise(resolve => { late = resolve; });
  } })).runNext(f.input);
  assert.equal(graceRejected, true); assert.equal(result.cleanupConfirmed, false);
  const operations = f.admission.records.list(), checks = f.checks.snapshot(f.input);
  assert.equal(operations.at(-1).state, 'quarantined'); assert.equal(checks.checks[0].commandId, undefined);
  assert.throws(() => raw.onDispatch({ processId: 'late' }), /late or duplicated/); raw.onOutput('late output');
  late({ exitCode: 0, output: 'late pass', cleanupVerified: true, truncated: false }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.admission.records.list(), operations); assert.deepEqual(f.checks.snapshot(f.input), checks); assert.equal(f.capacity.snapshot().occupied, 1);
});
