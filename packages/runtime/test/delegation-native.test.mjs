import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { Store } from '../dist/store.js';
import { Checkpoints } from '../dist/checkpoints.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationTasks } from '../dist/delegation-tasks.js';
import { DelegationSources } from '../dist/delegation-sources.js';
import { DelegationNative } from '../dist/delegation-native.js';
import { WorkspaceLeases } from '../dist/workspace-leases.js';
import { NativeAdmission } from '../dist/native-admission.js';
import { prepareWorkspace } from '../dist/workspace.js';

const selection = {
  harness: 'codex',
  executable: '/fixture-codex',
  executableVersion: 'fixture-1',
  model: 'fixture',
  effort: 'low',
};
const info = {
  executable: selection.executable,
  version: selection.executableVersion,
  available: true,
  authenticated: true,
  cleanupVerified: true,
  models: [{ id: 'fixture', efforts: ['low'] }],
  executionModes: ['read-only'],
};
function git(root, ...args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'init.templateDir=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}
function fixture(t, clock) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-native-task-'))),
    projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  git(projectRoot, 'init', '-b', 'main');
  writeFileSync(join(projectRoot, 'source.txt'), 'retained source');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-m', 'fixture');
  const store = new Store(join(root, 'data')),
    records = new DelegationRecords(store),
    controls = new DelegationControls(store, clock),
    tasks = new DelegationTasks(store);
  const conversationId = randomUUID(),
    workspace = prepareWorkspace(projectRoot, conversationId);
  const run = {
    createdAt: '2026-09-12T00:00:00.000Z',
    ...selection,
    id: 'run',
    projectId: 'project',
    conversationId,
    status: 'completed',
    workspace,
    enabledHarnessRoutes: [{ harness: 'codex', executable: selection.executable }],
  };
  store.putProject({ id: 'project', root: projectRoot });
  store.putConversation({ id: conversationId, projectId: 'project' });
  store.putRun(run);
  mkdirSync(store.runDirectory(run), { recursive: true });
  const checkpoint = new Checkpoints(store).capture(run, 'completed-turn');
  const assignment = (id, role, dependencies) => ({
    ...selection,
    id,
    role,
    dependencies,
    source: 'run-basis',
    mode: 'read-only',
    task: id,
    rationale: 'bounded work',
    deliverables: ['report'],
    completionCriteria: ['report retained'],
  });
  const plan = records.recordPlan({
    runId: run.id,
    revision: 1,
    requestId: 'request',
    source: 'proposal',
    basis: { checkpointDigest: checkpoint.digest, sourceTreeOid: checkpoint.snapshotTreeOid },
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
  const revision = {
    runId: run.id,
    planId: plan.id,
    digest: plan.digest,
    basisDigest: plan.basisDigest,
  };
  records.readyPlan(revision);
  const auth = records.authorize({ ...revision, decision: 'user', presetSaved: false });
  records.createTasks({ runId: run.id, authorizationId: auth.id });
  controls.create(run.id, auth.id);
  const task = records.tasks(run.id).find((item) => item.assignmentId === 'worker'),
    attemptId = randomUUID(),
    sessionId = randomUUID();
  const input = {
    runId: run.id,
    taskId: task.id,
    attemptId,
    sessionId,
    expectedGeneration: 1,
    messages: [{ role: 'user', text: 'Inspect source.txt and report.' }],
    signal: new AbortController().signal,
  };
  tasks.beginAttempt({
    ...input,
    authorizationId: auth.id,
    session: {
      ...selection,
      id: sessionId,
      role: 'worker',
      allowedTools: [],
      origin: { fixture: true },
    },
  });
  const sources = new DelegationSources(store, () => {
    throw new Error('unexpected output resolution');
  });
  const prepared = sources.prepare({ ...input, workspaceId: randomUUID() });
  tasks.bindPreparedAttempt({
    ...input,
    source: prepared.source,
    workspace: { path: prepared.workspace, identity: prepared.workspaceIdentity },
    contextArtifacts: [],
  });
  const admission = new NativeAdmission(store, { fixture: true }, { app: 1, perHarness: 1 }),
    leases = new WorkspaceLeases();
  const ownership = leases.acquire({
    reservationId: attemptId,
    runId: run.id,
    workspace: prepared.workspace,
  });
  input.workspaceLease = { reservationId: attemptId, generation: ownership.lease.generation };
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { store, records, controls, tasks, input, prepared, admission, leases, run, auth };
}
function adapter(overrides = {}) {
  return {
    async discover() {
      return info;
    },
    async run(input) {
      input.onEvent({
        type: 'session.turn-started',
        summary: 'started',
        data: { threadId: 'thread', turnId: 'turn' },
      });
      input.onEvent({
        type: 'message.delta',
        summary: 'answer',
        data: { text: 'Retained report.\nSecond line.' },
      });
      return { status: 'completed' };
    },
    ...overrides,
  };
}

test('prepared tasks use exact native identity with no delegation tools and retain session outcome separately', async (t) => {
  const f = fixture(t);
  let observed, duringModel;
  const native = new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
    adapter({
      async run(input) {
        observed = input;
        duringModel = f.admission.snapshot();
        return adapter().run(input);
      },
    }),
  );
  const result = await native.run(f.input);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.cleanupConfirmed, true);
  assert.match(result.summary, /Second line/);
  assert.equal(observed.applicationTools, undefined);
  assert.equal(observed.model, 'fixture');
  assert.equal(observed.workspace, f.prepared.workspace);
  assert.equal(f.records.sessions('run')[0].state, 'completed');
  assert.equal(f.records.tasks('run')[0].state, 'running');
  assert.equal(f.store.messages(f.run.conversationId).length, 0);
  assert.equal(f.admission.snapshot().capacity.occupied, 0);
  assert.equal(duringModel.capacity.occupied, 1);
  assert.equal(
    duringModel.operations.find((item) => item.purpose === 'discovery')?.state,
    'settled',
  );
  assert.deepEqual(
    f.controls.read('run').activities.map((item) => [item.stage, item.state]),
    [
      ['discovery', 'settled'],
      ['source-preparation', 'settled'],
      ['native-session', 'settled'],
    ],
  );
  await assert.rejects(native.run(f.input), /prepared|admission/);
});

test('missing discovery cleanup prevents inference and retains native occupancy quarantine', async (t) => {
  const f = fixture(t);
  let launches = 0;
  const native = new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
    adapter({
      async discover() {
        const value = { ...info };
        delete value.cleanupVerified;
        return value;
      },
      async run() {
        launches++;
        throw new Error('must not launch');
      },
    }),
  );
  const result = await native.run(f.input);
  assert.equal(launches, 0);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(f.admission.snapshot().capacity.occupied, 1);
  assert.equal(f.records.sessions('run')[0].state, 'cleanup-unconfirmed');
  assert.equal(f.controls.read('run').recoveryRequired, true);
});

test('Pause during discovery retains prepared work without launching; Pause during a turn allows it to settle', async (t) => {
  const before = fixture(t);
  let launches = 0;
  const pending = await new DelegationNative(
    before.store,
    before.controls,
    before.admission,
    before.leases,
    () =>
      adapter({
        async discover() {
          before.controls.command('run', 1, 'pause');
          return info;
        },
        async run() {
          launches++;
          return { status: 'completed' };
        },
      }),
  ).run(before.input);
  assert.equal(pending.status, 'pending');
  assert.equal(launches, 0);
  assert.equal(before.records.sessions('run')[0].state, 'prepared');
  assert.equal(before.admission.snapshot().capacity.occupied, 0);
  const during = fixture(t);
  const completed = await new DelegationNative(
    during.store,
    during.controls,
    during.admission,
    during.leases,
    () =>
      adapter({
        async run(input) {
          during.controls.command('run', 1, 'pause');
          return adapter().run(input);
        },
      }),
  ).run(during.input);
  assert.equal(completed.status, 'completed');
  assert.equal(during.controls.status(during.controls.read('run')), 'paused');
});

test('Stop or source replacement during discovery prevents model dispatch', async (t) => {
  for (const action of ['stop', 'edit']) {
    const f = fixture(t);
    let launches = 0;
    const result = await new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
      adapter({
        async discover() {
          if (action === 'stop') f.controls.command('run', 1, 'stop');
          else writeFileSync(join(f.prepared.workspace, 'source.txt'), 'changed');
          return info;
        },
        async run() {
          launches++;
          return { status: 'completed' };
        },
      }),
    ).run(f.input);
    assert.equal(launches, 0);
    assert.equal(result.status, 'failed');
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(f.admission.snapshot().capacity.occupied, 0);
  }
});

test('Runtime reopen retains known native cleanup while requiring task recovery without inference', async (t) => {
  const f = fixture(t);
  await new DelegationNative(f.store, f.controls, f.admission, f.leases, () => adapter()).run(
    f.input,
  );
  const dataRoot = f.store.root;
  f.store.close();
  let calls = 0;
  const runtime = new Runtime(
    adapter({
      async discover() {
        calls++;
        return info;
      },
      async run() {
        calls++;
        return { status: 'completed' };
      },
    }),
    dataRoot,
  );
  const reopened = runtime.snapshot().runs.find((item) => item.id === 'run');
  assert.equal(reopened.status, 'interrupted');
  assert.notEqual(reopened.cleanupUnconfirmed, true);
  assert.match(reopened.error, /Explicit recovery/);
  assert.equal(calls, 0);
  await runtime.close();
  const retained = new Store(dataRoot);
  assert.equal(new DelegationRecords(retained).sessions('run')[0].cleanupConfirmed, true);
  assert.equal(
    new DelegationRecords(retained).tasks('run')[0].attempts[0].runtimeRecoveryRequired,
    true,
  );
  retained.close();
});

test('two executor instances cannot settle or launch the same claimed native session', async (t) => {
  const f = fixture(t);
  let release, entered;
  const discovery = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const sharedAdapter = adapter({
    async discover() {
      entered();
      await discovery;
      return info;
    },
  });
  const first = new DelegationNative(
    f.store,
    f.controls,
    f.admission,
    f.leases,
    () => sharedAdapter,
  ).run(f.input);
  await started;
  await assert.rejects(
    new DelegationNative(f.store, f.controls, f.admission, f.leases, () => sharedAdapter).run(
      f.input,
    ),
    /already claimed/,
  );
  assert.equal(f.records.sessions('run')[0].state, 'prepared');
  assert.equal(f.records.sessions('run')[0].cleanupConfirmed, undefined);
  release();
  assert.equal((await first).status, 'completed');
  assert.equal(f.admission.snapshot().capacity.occupied, 0);
});

test('late callbacks cannot mutate settled evidence and multilingual output remains retainable', async (t) => {
  const f = fixture(t);
  let callback;
  const result = await new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
    adapter({
      async run(input) {
        callback = input.onEvent;
        input.onEvent({
          type: 'session.turn-started',
          summary: 'started',
          data: { threadId: 'thread', turnId: 'turn' },
        });
        input.onEvent({
          type: 'message.delta',
          summary: 'answer',
          data: { text: '文'.repeat(10000) },
        });
        return { status: 'completed' };
      },
    }),
  ).run(f.input);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.summary) <= 16000);
  assert.equal(result.summary.includes('�'), false);
  const events = f.store.events('run').length;
  callback({
    type: 'session.turn-started',
    summary: 'late',
    data: { threadId: 'foreign', turnId: 'foreign' },
  });
  callback({ type: 'message.delta', summary: 'late', data: { text: 'late' } });
  assert.equal(f.store.events('run').length, events);
  f.tasks.finishAttempt({
    ...f.input,
    status: 'completed',
    result: { summary: result.summary, artifacts: [], success: true },
  });
  assert.equal(
    f.records.tasks('run').find((item) => item.id === f.input.taskId).state,
    'completed',
  );
});

test('budget exhaustion before a model turn can Resume the same prepared attempt without duplicate stage IDs', async (t) => {
  let at = 1000;
  const f = fixture(t, () => at);
  let expired = false,
    launches = 0;
  const tick = f.controls.tick.bind(f.controls);
  f.controls.tick = (runId) => {
    if (
      !expired &&
      f.controls
        .read(runId)
        .activities.some((item) => item.stage === 'native-session' && item.state === 'active')
    ) {
      at += 60001;
      expired = true;
    }
    return tick(runId);
  };
  const native = new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
    adapter({
      async run(input) {
        launches++;
        return adapter().run(input);
      },
    }),
  );
  const first = await native.run(f.input);
  assert.equal(first.status, 'pending');
  assert.equal(launches, 0);
  const paused = f.controls.read('run');
  const extended = f.controls.extendBudget('run', paused.revision, 60000);
  const resumed = f.controls.command('run', extended.revision, 'resume');
  const input = { ...f.input, expectedGeneration: resumed.generation };
  f.tasks.readmittedPreparedAttempt(input);
  const second = await native.run(input);
  assert.equal(second.status, 'completed');
  assert.equal(launches, 1);
  assert.equal(f.records.tasks('run').find((item) => item.id === input.taskId).attempts.length, 1);
});

test('native admission rejects a released or quarantined exact workspace lease without launching', async (t) => {
  const f = fixture(t);
  let launches = 0;
  f.leases.release({
    ...f.input.workspaceLease,
    cleanupConfirmed: false,
    cleanupEvidence: { fixture: 'cleanup-unknown' },
  });
  const result = await new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
    adapter({
      async discover() {
        launches++;
        return info;
      },
    }),
  ).run(f.input);
  assert.equal(result.status, 'failed');
  assert.equal(launches, 0);
  assert.equal(f.admission.snapshot().capacity.occupied, 0);
});

test('queued native input retains the validated context and scalar authority snapshot', async (t) => {
  const f = fixture(t);
  const request = { ...f.input, messages: [{ role: 'user', text: 'Original validated context.' }] };
  let observed;
  const result = await new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
    adapter({
      async discover() {
        request.messages[0].text = 'Changed during discovery';
        request.expectedGeneration = 999;
        request.workspaceLease.generation = 999;
        return info;
      },
      async run(input) {
        observed = input.messages;
        return adapter().run(input);
      },
    }),
  ).run(request);
  assert.equal(result.status, 'completed');
  assert.deepEqual(observed, [{ role: 'user', text: 'Original validated context.' }]);
});

test(
  'source edits during shared model queue wait cannot dispatch and that wait remains uncharged',
  { timeout: 20_000 },
  async (t) => {
    let elapsed = 0;
    const f = fixture(t, () => elapsed);
    let release,
      occupied,
      blocker,
      launches = 0;
    const started = new Promise((resolve) => {
      occupied = resolve;
    });
    const native = new DelegationNative(f.store, f.controls, f.admission, f.leases, () =>
      adapter({
        async discover() {
          blocker = f.admission
            .adapter(
              'codex',
              {
                async discover() {
                  occupied();
                  return await new Promise((resolve) => {
                    release = () => resolve(info);
                  });
                },
              },
              { owner: { kind: 'app-discovery', id: 'catalog-between-stages' } },
            )
            .discover();
          return info;
        },
        async run(input) {
          launches++;
          return adapter().run(input);
        },
      }),
    );
    t.after(() => release?.());
    const pending = native.run(f.input);
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.admission.records.list().find((item) => item.purpose === 'model-turn').state,
      'queued',
    );
    assert.ok(f.controls.read('run').activities.every((item) => item.state === 'settled'));
    elapsed = 45_000;
    f.controls.tick('run');
    assert.equal(f.controls.read('run').spentMs, 0);
    writeFileSync(join(f.prepared.workspace, 'source.txt'), 'changed while queued');
    release();
    await blocker;
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.match(result.error, /source changed/);
    assert.equal(launches, 0);
    assert.equal(f.admission.snapshot().capacity.occupied, 0);
    const operations = f.admission.records
      .list()
      .filter((item) => item.owner.kind === 'delegation');
    assert.ok(
      operations.every(
        (item) => item.capacity.role === 'worker' && item.capacity.authorizationId === f.auth.id,
      ),
    );
  },
);
