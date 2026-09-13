import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCheckpoint, restoreCheckpoint } from '../dist/checkpoint-storage.js';
import { Checkpoints } from '../dist/checkpoints.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationIntegrationStage } from '../dist/delegation-integration-stage.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { Store } from '../dist/store.js';
import { prepareWorkspace } from '../dist/workspace.js';
import { workspaceIdentity } from '../dist/workspace-identity.js';
import { WorkspaceLeases } from '../dist/workspace-leases.js';

const git = (root, ...args) => execFileSync('/usr/bin/git', ['-c', 'init.templateDir=', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8' }).trim();
const assignment = (id, role, dependencies, source, extra = {}) => ({ id, task: id, role, harness: 'codex', executable: '/fixture-codex', executableVersion: 'fixture-1', model: 'fixture', effort: 'low', rationale: 'fixture', dependencies, source, mode: role === 'main-synthesis' ? 'read-only' : 'code', deliverables: ['done'], completionCriteria: ['done'], ...(role === 'main-synthesis' ? {} : { producesSource: true }), ...extra });

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-integration-stage-'))), projectRoot = join(root, 'project'), data = join(root, 'data'); mkdirSync(projectRoot); git(projectRoot, 'init', '-b', 'main'); writeFileSync(join(projectRoot, 'file.txt'), 'base\n'); git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-m', 'seed');
  const store = new Store(data), project = { id: 'project', root: projectRoot, name: 'Fixture', createdAt: '2026-09-12T00:00:00.000Z' }, conversation = { id: randomUUID(), projectId: project.id, title: 'Fixture', model: 'fixture', effort: 'low', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', lastReadSequence: 0 }, workspace = prepareWorkspace(projectRoot, conversation.id), run = { id: 'run', projectId: project.id, conversationId: conversation.id, status: 'completed', model: 'fixture', effort: 'low', workspace, workspaceIdentity: workspaceIdentity(workspace), createdAt: conversation.createdAt, updatedAt: conversation.createdAt, lastActivityAt: conversation.createdAt };
  store.putProject(project); store.putConversation(conversation); store.putRun(run); mkdirSync(store.runDirectory(run), { recursive: true }); const checkpoint = new Checkpoints(store).capture(run, 'completed-turn');
  const records = new DelegationRecords(store), plan = records.recordPlan({ runId: run.id, revision: 1, requestId: 'request', source: 'proposal', basis: { checkpointDigest: checkpoint.digest, sourceTreeOid: checkpoint.snapshotTreeOid }, plan: { schemaVersion: 1, id: 'plan', revision: 1, limits: { maxWorkers: 1, maxParallel: 1, maxAttempts: 1, activeMinutes: 5 }, assignments: [assignment('worker', 'worker', [], 'run-basis'), assignment('integrate', 'main-integration', ['worker'], 'run-basis', { integrationInputs: ['worker'] }), assignment('verify', 'runtime-verification', ['integrate'], 'output:integrate'), assignment('synthesis', 'main-synthesis', ['verify'], 'output:verify')] } }), ready = records.readyPlan({ runId: run.id, planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest }), auth = records.authorize({ runId: run.id, planId: ready.id, digest: ready.digest, basisDigest: ready.basisDigest, decision: 'user', presetSaved: false }); records.createTasks({ runId: run.id, authorizationId: auth.id }); new DelegationControls(store).create(run.id, auth.id);
  const worker = records.tasks(run.id).find(item => item.assignmentId === 'worker'); const workerAttempt = { id: randomUUID(), generation: 1, status: 'completed', controlGeneration: 1, source: { checkpointDirectory: checkpoint.directory, checkpointDigest: checkpoint.digest, treeOid: checkpoint.snapshotTreeOid }, cleanupConfirmed: true, createdAt: run.createdAt, updatedAt: run.createdAt }; const writer = join(root, 'writer'), outputs = join(root, 'outputs'); mkdirSync(outputs); restoreCheckpoint(checkpoint.directory, checkpoint.digest, writer); writeFileSync(join(writer, 'file.txt'), 'worker\n'); const output = createCheckpoint(writer, outputs, { runId: run.id, authorizationId: auth.id, taskId: worker.id, attemptId: workerAttempt.id, source: workerAttempt.source }); store.db.prepare('UPDATE delegation_tasks SET document=? WHERE id=?').run(JSON.stringify({ ...worker, state: 'completed', attempts: [{ ...workerAttempt, result: { summary: 'done', artifacts: [], success: true, source: { checkpointDirectory: output.directory, checkpointDigest: output.digest, treeOid: output.snapshotTreeOid, producerTaskId: worker.id } } }] }), worker.id);
  const integration = records.tasks(run.id).find(item => item.assignmentId === 'integrate'), attempt = { id: randomUUID(), generation: 1, status: 'dispatching', sessionId: randomUUID(), controlGeneration: 1, createdAt: run.createdAt, updatedAt: run.createdAt }; store.db.prepare('UPDATE delegation_tasks SET document=? WHERE id=?').run(JSON.stringify({ ...integration, state: 'running', attempts: [attempt] }), integration.id); const leases = new WorkspaceLeases(); const acquired = leases.acquire({ reservationId: attempt.id, runId: run.id, workspace }); if (acquired.status !== 'acquired') throw new Error('fixture lease failed');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return { store, records, run, integration, attempt, leases };
}

test('retains a derived candidate, applies once, and only exposes it after the conversation workspace changed', t => {
  const f = fixture(t), stage = new DelegationIntegrationStage(f.store, f.leases), input = { runId: f.run.id, taskId: f.integration.id, attemptId: f.attempt.id, expectedGeneration: 1, lease: { reservationId: f.attempt.id, generation: 1 } };
  const plan = stage.prepare(input);
  assert.throws(() => stage.candidate(input), /not durably applied/i);
  stage.apply(input);
  assert.equal(readFileSync(join(f.run.workspace, 'file.txt'), 'utf8'), 'worker\n');
  assert.equal(stage.candidate(input).treeOid, plan.candidate.treeOid);
  assert.throws(() => stage.apply(input), /prepared current candidate/i);
});
