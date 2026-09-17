import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationTasks } from '../dist/delegation-tasks.js';
import { terminal } from '../dist/delegation-task-state.js';

const origin = {
  version: 1,
  hostIdHash: 'a'.repeat(64),
  bootSessionId: '11111111-1111-4111-8111-111111111111',
};
const assignment = (id, role, dependencies = [], source = 'run-basis', producesSource = false) => ({
  id,
  task: `${id} task`,
  role,
  harness: 'codex',
  executable: '/fixture-codex',
  executableVersion: 'fixture-1',
  model: 'fixture-model',
  effort: 'low',
  rationale: 'fixture',
  dependencies,
  source,
  mode: 'read-only',
  deliverables: ['receipt'],
  completionCriteria: ['done'],
  ...(producesSource ? { producesSource: true } : {}),
});
const source = (producerTaskId) => ({
  checkpointDirectory: '/checkpoints/source',
  checkpointDigest: 'a'.repeat(64),
  treeOid: 'b'.repeat(40),
  ...(producerTaskId ? { producerTaskId } : {}),
});
const workspace = { path: '/workspace/attempt', identity: { device: 12, inode: 34 } };

async function fixture(
  t,
  assignments = [
    assignment('worker', 'worker'),
    assignment('synthesis', 'main-synthesis', ['worker']),
  ],
) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-delegation-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    at = new Date().toISOString();
  store.putProject({ id: 'project', name: 'Project', root, createdAt: at });
  store.putConversation({
    id: 'conversation',
    projectId: 'project',
    title: 'Task',
    model: 'fixture-model',
    effort: 'low',
    createdAt: at,
    updatedAt: at,
    lastReadSequence: 0,
  });
  store.putRun({
    id: 'run',
    projectId: 'project',
    conversationId: 'conversation',
    workspace: root,
    status: 'running',
    model: 'fixture-model',
    effort: 'low',
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
  });
  const records = new DelegationRecords(store);
  const plan = records.recordPlan({
    runId: 'run',
    revision: 1,
    requestId: 'request',
    source: 'proposal',
    basis: { checkpointDigest: 'basis' },
    plan: {
      schemaVersion: 1,
      id: 'plan',
      revision: 1,
      assignments,
      limits: { maxWorkers: 4, maxParallel: 2, maxAttempts: 2, activeMinutes: 20 },
    },
  });
  records.readyPlan({
    runId: 'run',
    planId: plan.id,
    digest: plan.digest,
    basisDigest: plan.basisDigest,
  });
  const authorization = records.authorize({
    runId: 'run',
    planId: plan.id,
    digest: plan.digest,
    basisDigest: plan.basisDigest,
    decision: 'user',
    presetSaved: false,
  });
  const taskRecords = records.createTasks({ runId: 'run', authorizationId: authorization.id });
  const controls = new DelegationControls(store);
  const control = controls.create('run', authorization.id);
  return {
    store,
    records,
    tasks: new DelegationTasks(store),
    controls,
    control,
    authorization,
    taskRecords,
  };
}

function session(id, role = 'worker') {
  return {
    id,
    role,
    harness: 'codex',
    executable: '/fixture-codex',
    executableVersion: 'fixture-1',
    model: 'fixture-model',
    effort: 'low',
    allowedTools: [],
    origin,
  };
}

test('claims exactly once, records preparation before dispatch, binds the native turn, and exposes only confirmed output', async (t) => {
  const f = await fixture(t, [
    assignment('worker', 'worker', [], 'run-basis', true),
    assignment('reader', 'review', ['worker'], 'output:worker'),
    assignment('synthesis', 'main-synthesis', ['reader']),
  ]);
  const [worker, reader] = f.taskRecords;
  const claimed = f.tasks.beginAttempt({
    runId: 'run',
    taskId: worker.id,
    authorizationId: f.authorization.id,
    expectedGeneration: 1,
    attemptId: 'worker-attempt',
    session: session('worker-session'),
  });
  assert.equal(claimed.attempts[0].status, 'dispatching');
  assert.equal(f.records.sessions('run')[0].state, 'prepared');
  assert.throws(
    () =>
      f.tasks.beginAttempt({
        runId: 'run',
        taskId: worker.id,
        authorizationId: f.authorization.id,
        expectedGeneration: 1,
        attemptId: 'replay',
        session: session('replay-session'),
      }),
    /retries|queueable/,
  );
  assert.throws(
    () =>
      f.tasks.dispatchAttempt({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'worker-attempt',
        sessionId: 'worker-session',
        expectedGeneration: 1,
      }),
    /prepared source/,
  );
  f.tasks.beginPreparation({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    expectedGeneration: 1,
    workspaceId: 'workspace-1',
    source: source(),
  });
  assert.throws(
    () =>
      f.tasks.beginPreparation({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'worker-attempt',
        sessionId: 'worker-session',
        expectedGeneration: 1,
        workspaceId: 'workspace-1',
        source: source(),
      }),
    /requires recovery/,
  );
  f.tasks.completePreparation({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    expectedGeneration: 1,
    workspace,
  });
  assert.doesNotThrow(() =>
    f.tasks.completePreparation({
      runId: 'run',
      taskId: worker.id,
      attemptId: 'worker-attempt',
      sessionId: 'worker-session',
      expectedGeneration: 1,
      workspace,
    }),
  );
  assert.throws(
    () =>
      f.tasks.completePreparation({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'worker-attempt',
        sessionId: 'worker-session',
        expectedGeneration: 1,
        workspace: { ...workspace, path: '/other-workspace' },
      }),
    /different workspace/,
  );
  f.tasks.bindPreparedAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    expectedGeneration: 1,
    source: source(),
    contextArtifacts: ['context-a'],
    workspace,
  });
  assert.deepEqual(f.records.tasks('run')[0].attempts[0].workspace, workspace);
  f.tasks.dispatchAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    expectedGeneration: 1,
  });
  f.tasks.bindAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    threadId: 'thread',
    turnId: 'turn',
  });
  f.records.finishSession({
    runId: 'run',
    sessionId: 'worker-session',
    status: 'completed',
    cleanupConfirmed: true,
    cleanupEvidence: { process: 'gone' },
  });
  f.tasks.beginOutputPublication({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    expectedGeneration: 1,
  });
  assert.throws(
    () =>
      f.tasks.beginOutputPublication({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'worker-attempt',
        sessionId: 'worker-session',
        expectedGeneration: 1,
      }),
    /requires recovery/,
  );
  f.tasks.completeOutputPublication({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    expectedGeneration: 1,
    source: source(worker.id),
  });
  assert.doesNotThrow(() =>
    f.tasks.completeOutputPublication({
      runId: 'run',
      taskId: worker.id,
      attemptId: 'worker-attempt',
      sessionId: 'worker-session',
      expectedGeneration: 1,
      source: source(worker.id),
    }),
  );
  assert.throws(
    () =>
      f.tasks.completeOutputPublication({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'worker-attempt',
        sessionId: 'worker-session',
        expectedGeneration: 1,
        source: { ...source(worker.id), treeOid: 'c'.repeat(40) },
      }),
    /different source/,
  );
  assert.throws(
    () =>
      f.tasks.completeOutputPublication({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'worker-attempt',
        sessionId: 'worker-session',
        expectedGeneration: 1,
        source: { ...source('foreign-task') },
      }),
    /producer task ID conflicts/,
  );
  const done = f.tasks.finishAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'worker-attempt',
    sessionId: 'worker-session',
    status: 'completed',
    result: {
      summary: 'done\nwith retained output',
      artifacts: ['artifact-a'],
      success: true,
      source: source(worker.id),
    },
  });
  assert.equal(done.state, 'completed');
  assert.deepEqual(
    f.tasks.completedOutput({
      runId: 'run',
      authorizationId: f.authorization.id,
      producerTaskId: worker.id,
      consumerTaskId: reader.id,
    }),
    { attemptId: 'worker-attempt', source: source(worker.id) },
  );
  assert.equal(
    f.tasks.completedOutput({
      runId: 'run',
      authorizationId: f.authorization.id,
      producerTaskId: worker.id,
      consumerTaskId: worker.id,
    }),
    undefined,
  );
});

test('completion derives cleanup from the retained session and unknown cleanup cannot complete a task', async (t) => {
  const f = await fixture(t);
  const [worker] = f.taskRecords;
  f.tasks.beginAttempt({
    runId: 'run',
    taskId: worker.id,
    authorizationId: f.authorization.id,
    expectedGeneration: 1,
    attemptId: 'attempt',
    session: session('session'),
  });
  f.records.finishSession({
    runId: 'run',
    sessionId: 'session',
    status: 'failed',
    cleanupConfirmed: false,
  });
  const settled = f.tasks.finishAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    status: 'failed',
    result: { summary: 'failed', artifacts: [], success: false },
  });
  assert.equal(settled.state, 'cleanup-unconfirmed');
  assert.equal(settled.attempts[0].cleanupConfirmed, false);
  assert.equal(
    f.tasks.completedOutput({
      runId: 'run',
      authorizationId: f.authorization.id,
      producerTaskId: worker.id,
      consumerTaskId: 'none',
    }),
    undefined,
  );
});

test('priority changes and Pause let an already-active native result settle and publish after resume', async (t) => {
  const f = await fixture(t, [
    assignment('worker', 'worker', [], 'run-basis', true),
    assignment('synthesis', 'main-synthesis', ['worker'], 'output:worker'),
  ]);
  const [worker] = f.taskRecords;
  f.tasks.beginAttempt({
    runId: 'run',
    taskId: worker.id,
    authorizationId: f.authorization.id,
    expectedGeneration: 1,
    attemptId: 'attempt',
    session: session('session'),
  });
  f.tasks.bindPreparedAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: 1,
    source: source(),
    contextArtifacts: [],
    workspace,
  });
  f.tasks.dispatchAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: 1,
  });
  f.tasks.bindAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    threadId: 'thread',
    turnId: 'turn',
  });
  const priority = f.controls.setPriority('run', 1, 7);
  assert.equal(priority.generation, 1);
  assert.equal(priority.revision, 2);
  const paused = f.controls.command('run', priority.revision, 'pause');
  assert.equal(paused.desired, 'paused');
  f.records.finishSession({
    runId: 'run',
    sessionId: 'session',
    status: 'completed',
    cleanupConfirmed: true,
    cleanupEvidence: { process: 'gone' },
  });
  assert.throws(
    () =>
      f.tasks.beginOutputPublication({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'attempt',
        sessionId: 'session',
        expectedGeneration: paused.generation,
      }),
    /requires a running control/,
  );
  const resumed = f.controls.command('run', paused.revision, 'resume');
  assert.equal(resumed.desired, 'running');
  f.tasks.beginOutputPublication({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: resumed.generation,
  });
  f.tasks.completeOutputPublication({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: resumed.generation,
    source: source(worker.id),
  });
  const settled = f.tasks.finishAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    status: 'completed',
    result: { summary: 'late complete', artifacts: [], success: true, source: source(worker.id) },
  });
  assert.equal(settled.state, 'completed');
  assert.equal(settled.attempts[0].result.success, true);
  assert.equal(f.records.sessions('run')[0].cleanupConfirmed, true);
});

test('a completed native session can retain a failed checkpoint or capture outcome without claiming task success', async (t) => {
  const f = await fixture(t);
  const [worker] = f.taskRecords;
  f.tasks.beginAttempt({
    runId: 'run',
    taskId: worker.id,
    authorizationId: f.authorization.id,
    expectedGeneration: 1,
    attemptId: 'attempt',
    session: session('session'),
  });
  f.tasks.bindPreparedAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: 1,
    source: source(),
    contextArtifacts: [],
    workspace,
  });
  f.tasks.dispatchAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: 1,
  });
  f.tasks.bindAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    threadId: 'thread',
    turnId: 'turn',
  });
  f.records.finishSession({
    runId: 'run',
    sessionId: 'session',
    status: 'completed',
    cleanupConfirmed: true,
    cleanupEvidence: { process: 'gone' },
  });
  const settled = f.tasks.finishAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    status: 'failed',
    result: { summary: 'checkpoint capture failed', artifacts: [], success: false },
  });
  assert.equal(settled.state, 'failed');
  assert.equal(settled.attempts[0].cleanupConfirmed, true);
  assert.equal(f.records.sessions('run')[0].state, 'completed');
});

test('a successful source-producing task cannot finish without its completed exact publication receipt', async (t) => {
  const f = await fixture(t, [
    assignment('worker', 'worker', [], 'run-basis', true),
    assignment('synthesis', 'main-synthesis', ['worker'], 'output:worker'),
  ]);
  const [worker] = f.taskRecords;
  f.tasks.beginAttempt({
    runId: 'run',
    taskId: worker.id,
    authorizationId: f.authorization.id,
    expectedGeneration: 1,
    attemptId: 'attempt',
    session: session('session'),
  });
  f.tasks.bindPreparedAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: 1,
    source: source(),
    contextArtifacts: [],
    workspace,
  });
  f.tasks.dispatchAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    expectedGeneration: 1,
  });
  f.tasks.bindAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    threadId: 'thread',
    turnId: 'turn',
  });
  f.records.finishSession({
    runId: 'run',
    sessionId: 'session',
    status: 'completed',
    cleanupConfirmed: true,
    cleanupEvidence: { process: 'gone' },
  });
  assert.throws(
    () =>
      f.tasks.finishAttempt({
        runId: 'run',
        taskId: worker.id,
        attemptId: 'attempt',
        sessionId: 'session',
        status: 'completed',
        result: { summary: 'missing output', artifacts: [], success: true },
      }),
    /requires a completed output publication/,
  );
});

test('the shared terminal predicate settles a blocked reason only in the blocked state', () => {
  assert.equal(
    terminal({
      state: 'queued',
      blockedReason: 'terminal-predecessor',
      attempts: [],
    }),
    false,
  );
  assert.equal(
    terminal({
      state: 'running',
      blockedReason: 'synthesis-failed-graph',
      attempts: [],
    }),
    false,
  );
  assert.equal(terminal({ state: 'blocked', blockedReason: 'terminal-predecessor' }), true);
  assert.equal(terminal({ state: 'blocked' }), false);
  assert.equal(terminal({ state: 'queued' }), false);
  assert.equal(terminal({ state: 'cancelled', blockedReason: 'terminal-predecessor' }), true);
  assert.equal(terminal({ state: 'completed' }), true);
});

test('failed predecessors block a synthesis with an absent declared source and reopening quarantines unfinished task attempts', async (t) => {
  const f = await fixture(t, [
    assignment('worker', 'worker', [], 'run-basis', true),
    assignment('synthesis', 'main-synthesis', ['worker'], 'output:worker'),
  ]);
  const [worker, synthesis] = f.taskRecords;
  assert.deepEqual(f.tasks.blockUnreachable({ runId: 'run' }), []);
  f.tasks.beginAttempt({
    runId: 'run',
    taskId: worker.id,
    authorizationId: f.authorization.id,
    expectedGeneration: 1,
    attemptId: 'attempt',
    session: session('session'),
  });
  f.records.finishSession({
    runId: 'run',
    sessionId: 'session',
    status: 'failed',
    cleanupConfirmed: true,
    cleanupEvidence: { process: 'gone' },
  });
  f.tasks.finishAttempt({
    runId: 'run',
    taskId: worker.id,
    attemptId: 'attempt',
    sessionId: 'session',
    status: 'failed',
    result: { summary: 'failed', artifacts: [], success: false },
  });
  const blocked = f.tasks.blockUnreachable({ runId: 'run' });
  assert.deepEqual(
    blocked.map((task) => task.id),
    [synthesis.id],
  );
  assert.equal(blocked[0].state, 'blocked');
  assert.equal(blocked[0].blockedReason, 'synthesis-failed-graph');
  assert.equal(blocked[0].attempts.length, 0);
  assert.equal(terminal(blocked[0]), true);
  const born = await fixture(t);
  assert.equal(born.taskRecords[1].state, 'blocked');
  assert.equal(born.taskRecords[1].blockedReason, undefined);
  assert.equal(terminal(born.taskRecords[1]), false);
  assert.throws(
    () =>
      f.tasks.beginAttempt({
        runId: 'run',
        taskId: synthesis.id,
        authorizationId: f.authorization.id,
        expectedGeneration: 1,
        attemptId: 'synthesis-attempt',
        session: session('synthesis-session', 'main'),
      }),
    /frontier|queueable/,
  );
  const f2 = await fixture(t);
  const [open] = f2.taskRecords;
  f2.tasks.beginAttempt({
    runId: 'run',
    taskId: open.id,
    authorizationId: f2.authorization.id,
    expectedGeneration: 1,
    attemptId: 'open-attempt',
    session: session('open-session'),
  });
  assert.equal(f2.tasks.reconcileOnReopen()[0].state, 'cleanup-unconfirmed');
  const f3 = await fixture(t);
  const [settled] = f3.taskRecords;
  f3.tasks.beginAttempt({
    runId: 'run',
    taskId: settled.id,
    authorizationId: f3.authorization.id,
    expectedGeneration: 1,
    attemptId: 'settled-attempt',
    session: session('settled-session'),
  });
  f3.tasks.bindPreparedAttempt({
    runId: 'run',
    taskId: settled.id,
    attemptId: 'settled-attempt',
    sessionId: 'settled-session',
    expectedGeneration: 1,
    source: source(),
    contextArtifacts: [],
    workspace,
  });
  f3.tasks.dispatchAttempt({
    runId: 'run',
    taskId: settled.id,
    attemptId: 'settled-attempt',
    sessionId: 'settled-session',
    expectedGeneration: 1,
  });
  f3.tasks.bindAttempt({
    runId: 'run',
    taskId: settled.id,
    attemptId: 'settled-attempt',
    sessionId: 'settled-session',
    threadId: 'thread',
    turnId: 'turn',
  });
  f3.records.finishSession({
    runId: 'run',
    sessionId: 'settled-session',
    status: 'completed',
    cleanupConfirmed: true,
    cleanupEvidence: { process: 'gone' },
  });
  const [recovered] = f3.tasks.reconcileOnReopen();
  assert.equal(recovered.state, 'running');
  assert.equal(recovered.attempts[0].runtimeRecoveryRequired, true);
  assert.equal(f3.records.sessions('run')[0].cleanupConfirmed, true);
  assert.deepEqual(f3.tasks.reconcileOnReopen(), []);
  const recoveryFinish = f3.tasks.finishAttempt({
    runId: 'run',
    taskId: settled.id,
    attemptId: 'settled-attempt',
    sessionId: 'settled-session',
    status: 'completed',
    result: { summary: 'late result', artifacts: [], success: true },
  });
  assert.equal(recoveryFinish.state, 'failed');
  assert.equal(recoveryFinish.attempts[0].result.success, false);
  assert.equal(f3.records.sessions('run')[0].cleanupConfirmed, true);
  const f4 = await fixture(t);
  const [prepared] = f4.taskRecords;
  f4.tasks.beginAttempt({
    runId: 'run',
    taskId: prepared.id,
    authorizationId: f4.authorization.id,
    expectedGeneration: 1,
    attemptId: 'prepared-attempt',
    session: session('prepared-session'),
  });
  const paused = f4.controls.command('run', 1, 'pause');
  const resumed = f4.controls.command('run', paused.revision, 'resume');
  assert.doesNotThrow(() =>
    f4.tasks.readmittedPreparedAttempt({
      runId: 'run',
      taskId: prepared.id,
      attemptId: 'prepared-attempt',
      sessionId: 'prepared-session',
      expectedGeneration: resumed.generation,
    }),
  );
  assert.equal(f4.records.tasks('run')[0].attempts[0].controlGeneration, resumed.generation);
});
