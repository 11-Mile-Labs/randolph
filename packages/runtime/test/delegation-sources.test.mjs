import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Checkpoints } from '../dist/checkpoints.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationSources } from '../dist/delegation-sources.js';
import { DelegationTasks } from '../dist/delegation-tasks.js';
import { Store } from '../dist/store.js';
import { prepareWorkspace } from '../dist/workspace.js';

function git(root, ...args) { return execFileSync('/usr/bin/git', ['-c', 'init.templateDir=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8' }).trim(); }
function assignment(id, role, dependencies, source, producesSource = false) { return { id, task: `${id} task`, role, harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', model: 'fixture', effort: 'low', rationale: 'Retained fixture', dependencies, source, mode: 'read-only', deliverables: ['Retained result'], completionCriteria: ['Retained result exists'], ...(producesSource ? { producesSource: true } : {}) }; }

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-delegation-sources-'))), projectRoot = join(root, 'project'), data = join(root, 'data');
  mkdirSync(projectRoot); git(projectRoot, 'init', '-b', 'main'); writeFileSync(join(projectRoot, 'tracked.txt'), 'tracked\n'); writeFileSync(join(projectRoot, 'remove.txt'), 'remove\n'); git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-m', 'seed');
  const store = new Store(data), project = { id: 'project-one', root: projectRoot, name: 'Fixture', createdAt: '2026-09-12T00:00:00.000Z' }, conversation = { id: randomUUID(), projectId: project.id, title: 'Fixture', model: 'fixture', effort: 'low', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', lastReadSequence: 0 }, workspace = prepareWorkspace(projectRoot, conversation.id), run = { id: 'run-one', projectId: project.id, conversationId: conversation.id, status: 'completed', model: 'fixture', effort: 'low', workspace, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', lastActivityAt: '2026-09-12T00:00:00.000Z' };
  store.putProject(project); store.putConversation(conversation); store.putRun(run); mkdirSync(store.runDirectory(run), { recursive: true });
  const checkpoint = new Checkpoints(store).capture(run, 'completed-turn'), records = new DelegationRecords(store), plan = records.recordPlan({ runId: run.id, revision: 1, requestId: 'request-one', source: 'proposal', basis: { checkpointDigest: checkpoint.digest, sourceTreeOid: checkpoint.snapshotTreeOid }, plan: { schemaVersion: 1, id: 'plan-one', revision: 1, limits: { maxWorkers: 1, maxParallel: 1, maxAttempts: 1, activeMinutes: 1 }, assignments: [assignment('worker', 'worker', [], 'run-basis', true), assignment('synthesis', 'main-synthesis', ['worker'], 'output:worker')] } }), ready = records.readyPlan({ runId: run.id, planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest }), authorization = records.authorize({ runId: run.id, planId: ready.id, digest: ready.digest, basisDigest: ready.basisDigest, decision: 'user', presetSaved: false }), tasks = records.createTasks({ runId: run.id, authorizationId: authorization.id }); new DelegationControls(store).create(run.id, authorization.id);
  const outputs = new Map(), sources = new DelegationSources(store, input => { const resolved = outputs.get(input.producerTaskId); if (!resolved) throw new Error('No retained output is available.'); return resolved; });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, projectRoot, store, run, checkpoint, records, sources, tasks, outputs };
}

function task(f, assignmentId) { return f.records.tasks(f.run.id).find(item => item.assignmentId === assignmentId); }
function replaceTask(f, updated) { f.store.db.prepare('UPDATE delegation_tasks SET document=? WHERE id=?').run(JSON.stringify(updated), updated.id); }
function claim(f, current) {
  const attempt = { id: randomUUID(), generation: 1, status: 'dispatching', sessionId: randomUUID(), controlGeneration: 1, createdAt: f.run.createdAt, updatedAt: f.run.createdAt };
  replaceTask(f, { ...current, state: 'running', attempts: [attempt] });
  f.records.recordSession({ id: attempt.sessionId, runId: f.run.id, taskId: current.id, role: current.assignmentId === 'synthesis' ? 'main' : 'worker', harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', model: 'fixture', effort: 'low', allowedTools: [], state: 'prepared' });
  return attempt;
}
function settleSession(f, attempt) { f.records.bindSession({ runId: f.run.id, sessionId: attempt.sessionId, threadId: randomUUID(), turnId: randomUUID() }); f.records.finishSession({ runId: f.run.id, sessionId: attempt.sessionId, status: 'completed', cleanupConfirmed: true, cleanupEvidence: { process: 'gone' } }); }

test('materializes the exact run-basis and completed predecessor output without changing the parent', t => {
  const f = fixture(t), worker = task(f, 'worker'), workerAttempt = claim(f, worker), workspaceId = randomUUID(), head = git(f.projectRoot, 'rev-parse', 'HEAD'), index = git(f.projectRoot, 'status', '--porcelain=v1');
  const prepared = f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: workerAttempt.id, workspaceId });
  assert.deepEqual(f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: workerAttempt.id, workspaceId }), prepared);
  assert.throws(() => f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: workerAttempt.id, workspaceId: randomUUID() }), /different retained evidence/i);
  assert.equal(readFileSync(join(prepared.workspace, 'tracked.txt'), 'utf8'), 'tracked\n');
  writeFileSync(join(prepared.workspace, 'tracked.txt'), 'changed\n'); writeFileSync(join(prepared.workspace, 'new.bin'), Buffer.from([0, 255, 10])); chmodSync(join(prepared.workspace, 'tracked.txt'), 0o755); unlinkSync(join(prepared.workspace, 'remove.txt'));
  const recordedWorker = task(f, 'worker'), boundWorkerAttempt = { ...recordedWorker.attempts[0], status: 'running', workspace: { path: prepared.workspace, identity: prepared.workspaceIdentity }, source: prepared.source };
  replaceTask(f, { ...recordedWorker, attempts: [boundWorkerAttempt] }); settleSession(f, workerAttempt);
  const output = f.sources.capture({ runId: f.run.id, taskId: worker.id, attemptId: workerAttempt.id, expectedGeneration: 1, workspace: prepared.workspace, workspaceIdentity: prepared.workspaceIdentity });
  writeFileSync(join(prepared.workspace, 'tracked.txt'), 'mutated-after-publication\n');
  assert.deepEqual(f.sources.capture({ runId: f.run.id, taskId: worker.id, attemptId: workerAttempt.id, expectedGeneration: 1, workspace: prepared.workspace, workspaceIdentity: prepared.workspaceIdentity }), output);
  const completedWorker = task(f, 'worker'); replaceTask(f, { ...completedWorker, state: 'completed', attempts: [{ ...completedWorker.attempts[0], status: 'completed', cleanupConfirmed: true, result: { summary: 'Completed.', artifacts: [], success: true, source: output } }] }); f.outputs.set(worker.id, { attemptId: workerAttempt.id, source: output });
  const synthesis = task(f, 'synthesis'), synthesisAttempt = claim(f, synthesis), downstream = f.sources.prepare({ runId: f.run.id, taskId: synthesis.id, attemptId: synthesisAttempt.id, workspaceId: randomUUID() });
  assert.equal(readFileSync(join(downstream.workspace, 'tracked.txt'), 'utf8'), 'changed\n'); assert.deepEqual(readFileSync(join(downstream.workspace, 'new.bin')), Buffer.from([0, 255, 10])); assert.equal(statSync(join(downstream.workspace, 'tracked.txt')).mode & 0o111, 0o111); assert.throws(() => readFileSync(join(downstream.workspace, 'remove.txt')));
  assert.equal(git(f.projectRoot, 'rev-parse', 'HEAD'), head); assert.equal(git(f.projectRoot, 'status', '--porcelain=v1'), index);
});

test('refuses output materialization before the exact completed, cleanup-confirmed producer proof', t => {
  const f = fixture(t), worker = task(f, 'worker'), workerAttempt = claim(f, worker), prepared = f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: workerAttempt.id, workspaceId: randomUUID() });
  const current = task(f, 'worker'); replaceTask(f, { ...current, state: 'completed', attempts: [{ ...current.attempts[0], status: 'completed', workspace: { path: prepared.workspace, identity: prepared.workspaceIdentity }, source: prepared.source }] });
  const synthesis = task(f, 'synthesis'), synthesisAttempt = claim(f, synthesis);
  assert.throws(() => f.sources.prepare({ runId: f.run.id, taskId: synthesis.id, attemptId: synthesisAttempt.id, workspaceId: randomUUID() }), /completed attempt output|retained output|cleanup/i);
});

test('capture requires the stored attempt workspace and source binding', t => {
  const f = fixture(t), worker = task(f, 'worker'), attempt = claim(f, worker), prepared = f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, workspaceId: randomUUID() });
  assert.throws(() => f.sources.capture({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, expectedGeneration: 1, workspace: prepared.workspace, workspaceIdentity: prepared.workspaceIdentity }), /workspace, source identity, and confirmed completed native session/i);
});

test('an interrupted output-publication intent fails closed instead of recapturing a changed workspace', t => {
  const f = fixture(t), worker = task(f, 'worker'), attempt = claim(f, worker), prepared = f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, workspaceId: randomUUID() });
  const recorded = task(f, 'worker'); replaceTask(f, { ...recorded, attempts: [{ ...recorded.attempts[0], workspace: { path: prepared.workspace, identity: prepared.workspaceIdentity }, source: prepared.source }] }); settleSession(f, attempt);
  new DelegationTasks(f.store).beginOutputPublication({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, sessionId: attempt.sessionId, expectedGeneration: 1 });
  writeFileSync(join(prepared.workspace, 'tracked.txt'), 'changed-after-intent\n');
  assert.throws(() => f.sources.capture({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, expectedGeneration: 1, workspace: prepared.workspace, workspaceIdentity: prepared.workspaceIdentity }), /intent is unfinished|requires recovery/i);
});

test('an interrupted preparation intent fails closed instead of creating another workspace', t => {
  const f = fixture(t), worker = task(f, 'worker'), attempt = claim(f, worker), workspaceId = randomUUID(), source = { checkpointDirectory: f.checkpoint.directory, checkpointDigest: f.checkpoint.digest, treeOid: f.checkpoint.snapshotTreeOid };
  new DelegationTasks(f.store).beginPreparation({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, sessionId: attempt.sessionId, expectedGeneration: 1, workspaceId, source });
  assert.throws(() => f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, workspaceId }), /intent is unfinished|requires recovery/i);
  assert.throws(() => f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, workspaceId: randomUUID() }), /intent is unfinished|requires recovery/i);
});

test('a settled native attempt publishes after pause and resume with the current stage generation', t => {
  const f = fixture(t), worker = task(f, 'worker'), attempt = claim(f, worker), prepared = f.sources.prepare({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, workspaceId: randomUUID() });
  const recorded = task(f, 'worker'); replaceTask(f, { ...recorded, attempts: [{ ...recorded.attempts[0], workspace: { path: prepared.workspace, identity: prepared.workspaceIdentity }, source: prepared.source }] }); settleSession(f, attempt);
  const controls = new DelegationControls(f.store); const paused = controls.command(f.run.id, 1, 'pause'), resumed = controls.command(f.run.id, paused.revision, 'resume');
  const output = f.sources.capture({ runId: f.run.id, taskId: worker.id, attemptId: attempt.id, expectedGeneration: resumed.generation, workspace: prepared.workspace, workspaceIdentity: prepared.workspaceIdentity });
  assert.equal(output.producerTaskId, worker.id); assert.equal(f.records.sessions(f.run.id).length, 1);
});

test('new preparation requires the current authorization and exact retained basis tree', t => {
  const stale = fixture(t), staleWorker = task(stale, 'worker'), staleAttempt = claim(stale, staleWorker), first = stale.records.plans(stale.run.id)[0];
  stale.records.recordPlan({ runId: stale.run.id, revision: 2, requestId: 'new-request', source: 'proposal', basis: first.basis, plan: first.plan });
  assert.throws(() => stale.sources.prepare({ runId: stale.run.id, taskId: staleWorker.id, attemptId: staleAttempt.id, workspaceId: randomUUID() }), /current exact active authorization/i);

  const basis = fixture(t), basisWorker = task(basis, 'worker'), basisAttempt = claim(basis, basisWorker), current = basis.records.plans(basis.run.id)[0];
  basis.store.db.prepare('UPDATE delegation_plans SET document=? WHERE id=?').run(JSON.stringify({ ...current, basis: { ...current.basis, sourceTreeOid: '0'.repeat(40) } }), current.id);
  assert.throws(() => basis.sources.prepare({ runId: basis.run.id, taskId: basisWorker.id, attemptId: basisAttempt.id, workspaceId: randomUUID() }), /basis tree/i);
});

test('corrupt retained snapshots and replaced projects refuse source preparation', t => {
  const corrupt = fixture(t), corruptWorker = task(corrupt, 'worker'), corruptAttempt = claim(corrupt, corruptWorker);
  writeFileSync(join(corrupt.checkpoint.directory, 'manifest.json'), '{corrupt');
  assert.throws(() => corrupt.sources.prepare({ runId: corrupt.run.id, taskId: corruptWorker.id, attemptId: corruptAttempt.id, workspaceId: randomUUID() }), /checkpoint|manifest|digest/i);

  const replaced = fixture(t), replacedWorker = task(replaced, 'worker'), replacedAttempt = claim(replaced, replacedWorker);
  rmSync(replaced.projectRoot, { recursive: true, force: true }); mkdirSync(replaced.projectRoot);
  assert.throws(() => replaced.sources.prepare({ runId: replaced.run.id, taskId: replacedWorker.id, attemptId: replacedAttempt.id, workspaceId: randomUUID() }), /original project|Git repository|project/i);
});
