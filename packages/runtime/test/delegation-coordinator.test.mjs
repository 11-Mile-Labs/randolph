import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { Checkpoints } from '../dist/checkpoints.js';
import { retainedDelegationBasis } from '../dist/delegation-basis.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { DelegationControls } from '../dist/delegation-control.js';
import { DelegationIntegration } from '../dist/delegation-integration.js';
import { DelegationCoordinator } from '../dist/delegation-coordinator.js';
import { WorkspaceOwnership } from '../dist/workspace-ownership.js';
import { NativeAdmission } from '../dist/native-admission.js';
import { prepareWorkspace } from '../dist/workspace.js';
import { workspaceIdentity } from '../dist/workspace-identity.js';

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
  executionModes: ['read-only', 'code'],
  commandLifecycle: true,
};
const git = (root, ...args) =>
  execFileSync(
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
function fixture(t, clock) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-coordinator-'))),
    projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  git(projectRoot, 'init', '-b', 'main');
  writeFileSync(join(projectRoot, '.gitignore'), '.worktrees/\n');
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@10.0.0',
      scripts: { lint: 'echo lint', test: 'echo test' },
    }),
  );
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-m', 'fixture');
  const store = new Store(join(root, 'data')),
    records = new DelegationRecords(store),
    controls = new DelegationControls(store, () => (clock ? clock(store) : Date.now()));
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
    workspaceIdentity: workspaceIdentity(workspace),
    enabledHarnessRoutes: [{ harness: 'codex', executable: selection.executable }],
  };
  store.putProject({ id: 'project', root: projectRoot });
  store.putConversation({ id: conversationId, projectId: 'project' });
  store.putRun(run);
  mkdirSync(store.runDirectory(run), { recursive: true });
  new Checkpoints(store).capture(run, 'completed-turn');
  const assignment = (id, role, dependencies, source = 'run-basis', extra = {}) => ({
    ...selection,
    id,
    role,
    dependencies,
    source,
    mode: ['review', 'main-synthesis'].includes(role) ? 'read-only' : 'code',
    task: id,
    rationale: 'bounded work',
    deliverables: ['report'],
    completionCriteria: ['report retained'],
    ...extra,
  });
  const plan = records.recordPlan({
    runId: run.id,
    revision: 1,
    requestId: 'request',
    source: 'proposal',
    basis: retainedDelegationBasis(store, store.runs()[0]),
    plan: {
      schemaVersion: 1,
      id: 'plan',
      revision: 1,
      limits: { maxWorkers: 3, maxParallel: 2, maxAttempts: 1, activeMinutes: 5 },
      assignments: [
        assignment('writer-a', 'worker', [], 'run-basis', { producesSource: true }),
        assignment('writer-b', 'worker', [], 'run-basis', { producesSource: true }),
        assignment('integrate', 'main-integration', ['writer-a', 'writer-b'], 'run-basis', {
          producesSource: true,
          integrationInputs: ['writer-a', 'writer-b'],
        }),
        assignment('verify', 'runtime-verification', ['integrate'], 'output:integrate', {
          producesSource: true,
        }),
        assignment('review', 'review', ['verify'], 'output:verify'),
        assignment('synthesis', 'main-synthesis', ['verify', 'review'], 'output:verify'),
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
  const admission = new NativeAdmission(store, { fixture: true }),
    queue = admission.queue,
    capacity = queue.capacity,
    leases = new WorkspaceOwnership(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, records, controls, admission, capacity, queue, leases, run, projectRoot };
}
function adapter(events, override = {}) {
  return {
    async discover() {
      return info;
    },
    async run(input) {
      const { assignment } = JSON.parse(input.messages[0].text);
      events.push(assignment.id);
      input.onEvent({
        type: 'session.turn-started',
        summary: 'started',
        data: { threadId: randomUUID(), turnId: randomUUID() },
      });
      if (assignment.id.startsWith('writer-'))
        writeFileSync(join(input.workspace, assignment.id + '.txt'), assignment.id);
      else {
        assert.equal(readFileSync(join(input.workspace, 'writer-a.txt'), 'utf8'), 'writer-a');
        assert.equal(readFileSync(join(input.workspace, 'writer-b.txt'), 'utf8'), 'writer-b');
      }
      if (assignment.role === 'main-integration')
        writeFileSync(join(input.workspace, 'integrated.txt'), 'combined');
      if (assignment.role === 'main-synthesis' || assignment.role === 'review') {
        assert.equal(input.executionMode, 'read-only');
        assert.equal(readFileSync(join(input.workspace, 'integrated.txt'), 'utf8'), 'combined');
      }
      input.onEvent({
        type: 'message.delta',
        summary: 'answer',
        data: { text: `Completed ${assignment.id}` },
      });
      return { status: 'completed' };
    },
    async runCommand(input) {
      events.push(input.command.at(-1));
      input.onDispatch({ processId: randomUUID() });
      assert.equal(readFileSync(join(input.workspace, 'integrated.txt'), 'utf8'), 'combined');
      return { exitCode: 0, output: 'passed', truncated: false, cleanupVerified: true };
    },
    ...override,
  };
}
const coordinator = (f, value) =>
  new DelegationCoordinator(f.store, f.controls, f.admission, f.leases, () => value);

test('the coordinator drives two writers through conversation integration, all checks, review, and selected-main synthesis', async (t) => {
  const f = fixture(t),
    events = [],
    head = git(f.projectRoot, 'rev-parse', 'HEAD'),
    index = git(f.projectRoot, 'write-tree');
  const done = await coordinator(f, adapter(events)).drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    done.map((value) => [value.assignmentId, value.state, value.attempts.at(-1)?.error]),
    done.map((value) => [value.assignmentId, 'completed', undefined]),
  );
  assert.deepEqual(events.slice(2), ['integrate', 'lint', 'test', 'review', 'synthesis']);
  assert.equal(
    done.find((value) => value.assignmentId === 'integrate').attempts[0].workspace.path,
    f.run.workspace,
  );
  assert.equal(f.capacity.snapshot().occupied, 0);
  assert.equal(f.leases.snapshot().length, 0);
  assert.equal(git(f.projectRoot, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.projectRoot, 'write-tree'), index);
  assert.equal(git(f.projectRoot, 'status', '--porcelain'), '');
  assert.ok(f.controls.read('run').activities.every((value) => value.state === 'settled'));
  await coordinator(f, adapter(events)).drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  assert.equal(events.length, 7);
});

test('coordinator construction launches nothing and a retained active claim prevents duplicate ownership', async (t) => {
  const f = fixture(t),
    events = [];
  let began, release;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const native = adapter(events, {
    async discover() {
      began();
      return await new Promise((resolve) => {
        release = () => resolve(info);
      });
    },
  });
  const first = coordinator(f, native);
  assert.deepEqual(events, []);
  // Hold the only native slot so a single discovery callback owns the barrier.
  f.capacity.setLimits({ app: 1, perHarness: 1 });
  const execution = first.drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  await started;
  await assert.rejects(
    coordinator(f, adapter(events)).drive({
      runId: 'run',
      expectedGeneration: 1,
      signal: new AbortController().signal,
    }),
    /already claimed/,
  );
  const control = f.controls.read('run');
  f.controls.command('run', control.revision, 'stop');
  release();
  await execution;
  assert.ok(!events.length);
  assert.equal(f.capacity.snapshot().occupied, 0);
});

test('Pause between checks retains completed workers and exact check receipts; Resume does not rerun native work', async (t) => {
  const f = fixture(t),
    events = [];
  let first = true;
  const normal = adapter(events),
    native = adapter(events, {
      async runCommand(input) {
        const result = await normal.runCommand(input);
        if (first) {
          first = false;
          f.controls.command('run', f.controls.read('run').revision, 'pause');
        }
        return result;
      },
    });
  const before = await coordinator(f, native).drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  assert.deepEqual(events.slice(2), ['integrate', 'lint']);
  assert.equal(before.find((value) => value.assignmentId === 'verify').state, 'running');
  assert.equal(f.capacity.snapshot().occupied, 0);
  assert.equal(f.leases.snapshot().length, 1);
  const next = f.controls.command('run', f.controls.read('run').revision, 'resume');
  const done = await coordinator(f, native).drive({
    runId: 'run',
    expectedGeneration: next.generation,
    signal: new AbortController().signal,
  });
  assert.ok(
    done.every((value) => value.state === 'completed'),
    JSON.stringify(
      done.map((value) => [value.assignmentId, value.state, value.attempts.at(-1)?.error]),
    ),
  );
  assert.deepEqual(events.slice(2), ['integrate', 'lint', 'test', 'review', 'synthesis']);
  assert.equal(f.leases.snapshot().length, 0);
});

test('budget exhaustion after source preparation resumes its retained receipt without preparing again', async (t) => {
  let advance = false,
    at = Date.now();
  const f = fixture(t, (store) => {
    if (
      !advance &&
      new DelegationRecords(store)
        .tasks('run')
        .some((task) =>
          task.attempts.some(
            (attempt) => attempt.preparation?.state === 'completed' && !attempt.workspace,
          ),
        )
    ) {
      advance = true;
      at += 301_000;
    }
    return at;
  });
  const events = [],
    native = adapter(events);
  await coordinator(f, native).drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  assert.equal(f.controls.read('run').desired, 'paused');
  assert.equal(events.length, 0);
  const held = f.records
    .tasks('run')
    .find((task) => task.attempts.some((attempt) => attempt.preparation?.state === 'completed'));
  const priorWorkspace = held.attempts[0].preparation.workspace;
  const extended = f.controls.extendBudget('run', f.controls.read('run').revision, 300_000),
    resumed = f.controls.command('run', extended.revision, 'resume');
  const done = await coordinator(f, native).drive({
    runId: 'run',
    expectedGeneration: resumed.generation,
    signal: new AbortController().signal,
  });
  assert.ok(
    done.every((value) => value.state === 'completed'),
    JSON.stringify(
      done.map((value) => [value.assignmentId, value.state, value.attempts.at(-1)?.error]),
    ),
  );
  assert.deepEqual(
    done.find((task) => task.id === held.id).attempts[0].preparation.workspace,
    priorWorkspace,
  );
});

test('budget exhaustion after integration apply resumes without reapplying its candidate', async (t) => {
  let advance = false,
    at = Date.now();
  const f = fixture(t, (store) => {
    if (
      !advance &&
      new DelegationRecords(store)
        .tasks('run')
        .some((task) =>
          task.attempts.some(
            (attempt) => attempt.integration?.state === 'applied' && !attempt.workspace,
          ),
        )
    ) {
      advance = true;
      at += 301_000;
    }
    return at;
  });
  const events = [],
    native = adapter(events);
  await coordinator(f, native).drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  assert.equal(f.controls.read('run').desired, 'paused');
  assert.equal(events.length, 2);
  const extended = f.controls.extendBudget('run', f.controls.read('run').revision, 300_000),
    resumed = f.controls.command('run', extended.revision, 'resume');
  const done = await coordinator(f, native).drive({
    runId: 'run',
    expectedGeneration: resumed.generation,
    signal: new AbortController().signal,
  });
  assert.ok(
    done.every((value) => value.state === 'completed'),
    JSON.stringify(
      done.map((value) => [value.assignmentId, value.state, value.attempts.at(-1)?.error]),
    ),
  );
  assert.equal(
    f.controls.read('run').activities.filter((value) => value.id.endsWith(':apply')).length,
    1,
  );
});

test('failed raw integration keeps the conversation writer lease quarantined', async (t) => {
  const f = fixture(t),
    events = [],
    original = DelegationIntegration.prototype.apply;
  DelegationIntegration.prototype.apply = () => {
    throw new Error('Injected partial raw apply failure');
  };
  try {
    await coordinator(f, adapter(events)).drive({
      runId: 'run',
      expectedGeneration: 1,
      signal: new AbortController().signal,
    });
    assert.ok(
      f.controls.read('run').activities.some((value) => value.state === 'cleanup-unconfirmed'),
    );
    const lease = f.leases.snapshot().find((value) => value.workspace === f.run.workspace);
    assert.equal(lease.state, 'cleanup-unconfirmed');
    assert.equal(events.length, 2);
  } finally {
    DelegationIntegration.prototype.apply = original;
  }
});

test('a priority change during discovery preserves the admitted generation without restarting work', async (t) => {
  const f = fixture(t),
    events = [];
  let first = true;
  const native = adapter(events, {
    async discover() {
      if (first) {
        first = false;
        const priority = f.controls.setPriority('run', f.controls.read('run').revision, 10);
        assert.equal(priority.generation, 1);
      }
      return info;
    },
  });
  const done = await coordinator(f, native).drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  assert.ok(
    done.every((value) => value.state === 'completed'),
    JSON.stringify(
      done.map((value) => [value.assignmentId, value.state, value.attempts.at(-1)?.error]),
    ),
  );
  assert.equal(f.controls.read('run').generation, 1);
  assert.equal(events.length, 7);
});

test('budget expiry inside begin stays paused instead of failing an unlaunched task', async (t) => {
  let at = Date.now();
  const f = fixture(t, () => at),
    events = [];
  const active = f.controls.begin('run', 1, 'existing-runtime-stage', 'checkpoint');
  const original = f.controls.begin.bind(f.controls);
  let inject = true;
  f.controls.begin = (...args) => {
    if (inject) {
      inject = false;
      at += 301_000;
    }
    return original(...args);
  };
  const paused = await coordinator(f, adapter(events)).drive({
    runId: 'run',
    expectedGeneration: 1,
    signal: new AbortController().signal,
  });
  assert.equal(f.controls.read('run').desired, 'paused');
  assert.ok(paused.every((task) => task.state !== 'failed'));
  assert.equal(events.length, 0);
  assert.ok(paused.find((task) => task.assignmentId === 'writer-a').attempts[0]);
  f.controls.finish('run', active.token, { confirmed: true, evidence: { fixture: 'settled' } });
});

function breakDelegationTaskWrites(store, active, oneShot = false) {
  const database = store.db,
    original = database.prepare;
  let thrown = 0;
  database.prepare = (sql) => {
    const statement = original.call(database, sql);
    if (!active() || !sql.includes('UPDATE delegation_tasks')) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== 'run') {
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args) => {
          if (oneShot && thrown) return target.run(...args);
          thrown += 1;
          throw new Error('Injected delegation task write failure');
        };
      },
    });
  };
  return () => {
    database.prepare = original;
  };
}

test('a failed task attempt settles its session, attempt and failure evidence atomically', async (t) => {
  const f = fixture(t),
    events = [],
    originalApply = DelegationIntegration.prototype.apply;
  let breakTasks = false;
  DelegationIntegration.prototype.apply = () => {
    breakTasks = true;
    throw new Error('Injected partial raw apply failure');
  };
  const restorePrepare = breakDelegationTaskWrites(f.store, () => breakTasks);
  try {
    await coordinator(f, adapter(events)).drive({
      runId: 'run',
      expectedGeneration: 1,
      signal: new AbortController().signal,
    });
  } finally {
    restorePrepare();
    DelegationIntegration.prototype.apply = originalApply;
  }
  const task = f.records.tasks('run').find((value) => value.assignmentId === 'integrate'),
    attempt = task.attempts.at(-1),
    session = f.records.sessions('run').find((value) => value.id === attempt.sessionId),
    failures = f.store
      .events('run')
      .filter((value) => value.type === 'delegation.coordinator-task-failed');
  assert.equal(task.state, 'running');
  assert.equal(attempt.status, 'dispatching');
  assert.equal(attempt.runtimeRecoveryRequired, undefined);
  assert.equal(attempt.error, undefined);
  assert.equal(session.state, 'prepared');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].data.taskId, task.id);
  assert.match(failures[0].data.error, /Injected partial raw apply failure/);
  assert.match(failures[0].data.settlementError, /Injected delegation task write failure/);
});

test('a failed attempt whose fallback succeeds still records session, attempt and evidence together', async (t) => {
  const f = fixture(t),
    events = [],
    originalApply = DelegationIntegration.prototype.apply;
  let breakTasks = false;
  DelegationIntegration.prototype.apply = () => {
    breakTasks = true;
    throw new Error('Injected partial raw apply failure');
  };
  const restorePrepare = breakDelegationTaskWrites(f.store, () => breakTasks, true);
  try {
    await coordinator(f, adapter(events)).drive({
      runId: 'run',
      expectedGeneration: 1,
      signal: new AbortController().signal,
    });
  } finally {
    restorePrepare();
    DelegationIntegration.prototype.apply = originalApply;
  }
  const task = f.records.tasks('run').find((value) => value.assignmentId === 'integrate'),
    attempt = task.attempts.at(-1),
    session = f.records.sessions('run').find((value) => value.id === attempt.sessionId),
    failures = f.store
      .events('run')
      .filter((value) => value.type === 'delegation.coordinator-task-failed');
  assert.equal(session.state, 'failed');
  assert.equal(attempt.runtimeRecoveryRequired, true);
  assert.match(attempt.error, /Injected partial raw apply failure/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].data.settlementError, undefined);
});
