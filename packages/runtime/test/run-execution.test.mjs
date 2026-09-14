import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceOwnership } from '../dist/workspace-ownership.js';
import { Store } from '../dist/store.js';
import { NativeAdmission } from '../dist/native-admission.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { runExecutionSnapshot } from '../dist/run-execution.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'randolph-activity-'))),
    store = new Store(root);
  store.putProject({ id: 'project', root });
  store.putConversation({ id: 'conversation', projectId: 'project' });
  for (const id of ['run', 'other'])
    store.putRun({
      id,
      projectId: 'project',
      conversationId: 'conversation',
      status: 'completed',
      harness: 'codex',
    });
  const native = new NativeAdmission(store, {}, { app: 1, perHarness: 1 });
  t.after(async () => {
    await native.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, native };
}
function graph(store) {
  const records = new DelegationRecords(store),
    controls = new DelegationControls(store, () => 1000);
  const assignment = (id, role, dependencies) => ({
    id,
    role,
    dependencies,
    source: 'run-basis',
    mode: 'read-only',
    task: `${id} task`,
    harness: 'codex',
    executable: '/opt/codex',
    executableVersion: '1',
    model: 'model',
    effort: 'low',
    rationale: 'bounded task',
    deliverables: ['report'],
    completionCriteria: ['complete'],
  });
  const plan = records.recordPlan({
    runId: 'run',
    revision: 1,
    requestId: 'request',
    source: 'proposal',
    basis: { tree: 'tree' },
    plan: {
      schemaVersion: 1,
      id: 'plan',
      revision: 1,
      limits: { maxWorkers: 1, maxParallel: 1, maxAttempts: 1, activeMinutes: 1 },
      assignments: [
        assignment('worker', 'worker', []),
        assignment('synthesis', 'main-synthesis', ['worker']),
      ],
    },
  });
  const exact = {
    runId: 'run',
    planId: plan.id,
    digest: plan.digest,
    basisDigest: plan.basisDigest,
  };
  records.readyPlan(exact);
  const authorization = records.authorize({ ...exact, decision: 'user', presetSaved: false });
  records.createTasks({ runId: 'run', authorizationId: authorization.id });
  controls.create('run', authorization.id);
  return { records, controls };
}
const cleanup = () => ({ status: 'completed', confirmed: true, evidence: { fake: 'settled' } });

test('queue display is immediate at full capacity and reading it launches or mutates nothing', async (t) => {
  const { store, native } = await fixture(t);
  let release,
    launches = 0;
  const active = native.perform(
    'codex',
    { owner: { kind: 'run', id: 'other' }, runId: 'other' },
    'command',
    undefined,
    undefined,
    async (signal) => {
      launches++;
      await new Promise((resolve) => {
        release = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      });
    },
    cleanup,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const queued = native.perform(
    'codex',
    { owner: { kind: 'run', id: 'run' }, runId: 'run' },
    'model-turn',
    undefined,
    undefined,
    async () => {
      launches++;
    },
    cleanup,
  );
  assert.equal(
    runExecutionSnapshot(store, native, 'other').status,
    'running',
    'an admitted check is active even when its main run completed',
  );
  const run = store.runs().find((item) => item.id === 'run');
  store.putRun({ ...run, status: 'stopping' });
  assert.equal(
    runExecutionSnapshot(store, native, 'run').status,
    'stopping',
    'queued work must not hide Stop',
  );
  store.putRun(run);
  const before = JSON.stringify(native.snapshot()),
    events = JSON.stringify(store.events('run'));
  for (let i = 0; i < 3; i++) {
    const snapshot = runExecutionSnapshot(store, native, 'run');
    assert.equal(snapshot.status, 'waiting');
    assert.equal(snapshot.capacity.occupied, 1);
    assert.equal(snapshot.operations.length, 1);
    assert.match(snapshot.operations[0].reason, /app slot \(1\/1/);
    assert.equal(snapshot.operations[0].status, 'queued');
  }
  assert.equal(launches, 1);
  assert.equal(JSON.stringify(native.snapshot()), before);
  assert.equal(JSON.stringify(store.events('run')), events);
  release();
  await Promise.all([active, queued]);
  assert.equal(runExecutionSnapshot(store, native, 'run').operations.length, 0);
  assert.throws(() => runExecutionSnapshot(store, native, 'missing'), /does not exist/);
});

test('paused tasks remain visible without native queue entries and status reads never charge time', async (t) => {
  const { store, native } = await fixture(t),
    { controls } = graph(store);
  assert.equal(runExecutionSnapshot(store, native, 'run').status, 'waiting');
  controls.command('run', 1, 'pause');
  const before = JSON.stringify(controls.read('run')),
    events = JSON.stringify(store.events('run'));
  const snapshot = runExecutionSnapshot(store, native, 'run');
  assert.equal(snapshot.status, 'paused');
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(snapshot.operations.length, 0);
  assert.match(snapshot.tasks[0].reason, /Paused/);
  assert.equal(snapshot.tasks[0].label, 'worker task');
  assert.equal(snapshot.control.spentMs, 0);
  assert.equal(snapshot.control.revision, 2);
  assert.equal(JSON.stringify(controls.read('run')), before);
  assert.equal(JSON.stringify(store.events('run')), events);
});

test('terminal task outcomes supersede desired running but recovery remains visible', async (t) => {
  const { store, native } = await fixture(t),
    { records, controls } = graph(store);
  for (const task of records.tasks('run'))
    store.db
      .prepare('UPDATE delegation_tasks SET document=? WHERE id=?')
      .run(JSON.stringify({ ...task, state: 'completed' }), task.id);
  assert.equal(runExecutionSnapshot(store, native, 'run').status, 'completed');
  controls.reconcileOnReopen();
  assert.equal(runExecutionSnapshot(store, native, 'run').status, 'interrupted');
  assert.equal(runExecutionSnapshot(store, native, 'run').control.recoveryRequired, true);
});

test('unconfirmed cleanup remains visible and occupied after reopen without adapter discovery', async (t) => {
  const { store, native } = await fixture(t);
  await assert.rejects(
    native.perform(
      'codex',
      { owner: { kind: 'run', id: 'run' }, runId: 'run' },
      'model-turn',
      undefined,
      undefined,
      async () => {
        throw new Error('unknown cleanup');
      },
      cleanup,
    ),
  );
  const reopened = new NativeAdmission(store, {}, { app: 1, perHarness: 1 });
  const snapshot = runExecutionSnapshot(store, reopened, 'run');
  assert.equal(snapshot.status, 'interrupted');
  assert.equal(snapshot.capacity.occupied, 1);
  assert.equal(snapshot.operations[0].status, 'quarantined');
  assert.match(snapshot.operations[0].reason, /cleanup is unconfirmed/);
  await reopened.close();
});

test('ordinary cleanup flags and workspace quarantine remain visible without a native operation', async (t) => {
  const { store, native } = await fixture(t);
  const run = store.runs().find((item) => item.id === 'run');
  store.putRun({ ...run, cleanupUnconfirmed: true });
  const flag = runExecutionSnapshot(store, native, 'run');
  assert.equal(flag.cleanupRequired, true);
  assert.equal(flag.status, 'interrupted');
  assert.equal(flag.operations.length, 0);
  store.putRun({ ...run, cleanupUnconfirmed: false });
  const ownership = new WorkspaceOwnership(store);
  const acquired = ownership.acquire({
    reservationId: 'workspace-only',
    ownerId: 'run',
    provenance: { kind: 'run', id: 'run', projectId: 'project', conversationId: 'conversation' },
    workspace: join(store.root, 'planned'),
  });
  assert.equal(acquired.status, 'acquired');
  ownership.release({
    ...acquired.lease,
    cleanupConfirmed: false,
    cleanupEvidence: { fixture: 'runtime cleanup unknown' },
  });
  const retained = runExecutionSnapshot(store, native, 'run');
  assert.equal(retained.cleanupRequired, true);
  assert.equal(retained.status, 'interrupted');
  assert.equal(retained.capacity.occupied, 0);
  assert.equal(retained.operations.length, 0);
  assert.match(retained.cleanupReasons[0], /workspace operation/);
  assert.equal(runExecutionSnapshot(store, native, 'other').cleanupRequired, false);
});

test('legacy native cleanup witnesses are visible without modern operation records', async (t) => {
  const { store, native } = await fixture(t);
  native.queue.capacity.restore([
    {
      reservationId: 'legacy',
      ownerId: 'run',
      runId: 'run',
      harness: 'codex',
      role: 'main',
      generation: 1,
      state: 'cleanup-unconfirmed',
    },
  ]);
  const snapshot = runExecutionSnapshot(store, native, 'run');
  assert.equal(snapshot.status, 'interrupted');
  assert.equal(snapshot.cleanupRequired, true);
  assert.equal(snapshot.operations.length, 0);
  assert.equal(snapshot.capacity.occupied, 1);
  assert.match(snapshot.cleanupReasons[0], /retained native slot/);
});
