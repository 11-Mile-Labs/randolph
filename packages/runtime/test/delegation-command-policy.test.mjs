import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { delegationCommandPolicy } from '../dist/delegation-command-policy.js';
import { defaultDelegationLimits } from '../dist/delegation-plan.js';
import { Runtime, Store } from '../dist/index.js';

const BUSY = 'Wait for current work to settle before changing this proposal.';
const SUPERSEDED = 'A newer conversation request superseded this proposal.';
const UNSETTLED = 'Native work and cleanup must settle before a proposal decision.';
const UNINSPECTABLE = 'A proposed CLI could not be inspected. Refresh before approval.';
const IDENTITY = 'The retained main-agent CLI identity is incomplete.';
const AT = '2026-09-12T00:00:00.000Z';

const run = (extra = {}) => ({
  id: 'run-one',
  projectId: 'project-one',
  conversationId: 'conversation-one',
  status: 'completed',
  model: 'model',
  effort: 'low',
  executable: '/opt/codex',
  executableVersion: '1',
  createdAt: AT,
  updatedAt: AT,
  lastActivityAt: AT,
  ...extra,
});
const readers = (overrides = {}) => ({
  store: { runs: () => [run()] },
  nativeAdmission: { adapter: (_harness, found) => found },
  adapters: {},
  isAccepting: () => true,
  isAdmitting: () => false,
  isRunActive: () => false,
  reviewsBusy: () => false,
  pushesBusy: () => false,
  sessions: () => [],
  ...overrides,
});
const revision = (assignments) => ({ plan: { assignments } });
const assignment = (harness, executable) => ({ harness, executable });
const info = (extra = {}) => ({
  available: true,
  authenticated: true,
  executable: '/opt/codex',
  version: '1',
  models: [{ id: 'model', efforts: ['low'], extra: 'dropped' }],
  executionModes: ['code', 'read-only'],
  commandLifecycle: true,
  ...extra,
});

test('assertMutable rejects with the busy message for each independent reader', () => {
  const blockers = [
    { isAccepting: () => false },
    { isAdmitting: (id) => id === 'conversation-one' },
    { isRunActive: (id) => id === 'run-one' },
    { reviewsBusy: () => true },
    { pushesBusy: () => true },
  ];
  assert.doesNotThrow(() => delegationCommandPolicy(readers()).assertMutable(run()));
  for (const blocker of blockers)
    assert.throws(
      () => delegationCommandPolicy(readers(blocker)).assertMutable(run()),
      new Error(BUSY),
      `reader ${Object.keys(blocker)[0]} must block`,
    );
});

test('assertMutable rejects a superseded proposal and accepts the latest run', () => {
  const older = run(),
    newer = run({ id: 'run-two' });
  assert.throws(
    () =>
      delegationCommandPolicy(readers({ store: { runs: () => [older, newer] } })).assertMutable(
        older,
      ),
    new Error(SUPERSEDED),
  );
  assert.doesNotThrow(() =>
    delegationCommandPolicy(readers({ store: { runs: () => [older, newer] } })).assertMutable(
      newer,
    ),
  );
  assert.doesNotThrow(() =>
    delegationCommandPolicy(
      readers({ store: { runs: () => [older, run({ id: 'other', conversationId: 'other' })] } }),
    ).assertMutable(older),
  );
});

test('assertMutable rejects a blocking run and every unsettled session state', () => {
  const blocking = run({ status: 'running' });
  assert.throws(
    () =>
      delegationCommandPolicy(readers({ store: { runs: () => [blocking] } })).assertMutable(
        blocking,
      ),
    new Error(UNSETTLED),
  );
  for (const state of ['prepared', 'dispatch-intent', 'running', 'cleanup-unconfirmed'])
    assert.throws(
      () => delegationCommandPolicy(readers({ sessions: () => [{ state }] })).assertMutable(run()),
      new Error(UNSETTLED),
      `session state ${state} must block`,
    );
  assert.doesNotThrow(() =>
    delegationCommandPolicy(readers({ sessions: () => [{ state: 'completed' }] })).assertMutable(
      run(),
    ),
  );
});

test('assertMutable reads its dependencies lazily on every call', () => {
  let late;
  const policy = delegationCommandPolicy(
    readers({
      reviewsBusy: (id) => late?.hasActiveWork(id) ?? false,
      pushesBusy: (id) => late?.hasActiveWork(id) ?? false,
    }),
  );
  assert.doesNotThrow(() => policy.assertMutable(run()));
  late = { hasActiveWork: () => true };
  assert.throws(() => policy.assertMutable(run()), new Error(BUSY));
  late = { hasActiveWork: () => false };
  assert.doesNotThrow(() => policy.assertMutable(run()));
});

test('availability dedupes assignments by harness and executable', async () => {
  let discoveries = 0;
  const adapter = {
    discover: async () => {
      discoveries += 1;
      return info();
    },
  };
  const result = await delegationCommandPolicy(
    readers({ adapters: { codex: adapter } }),
  ).availability(
    run({ enabledHarnessRoutes: [{ harness: 'codex', executable: '/opt/codex' }] }),
    revision([
      assignment('codex', '/opt/codex'),
      assignment('codex', '/opt/codex'),
      assignment('codex', '/opt/codex'),
    ]),
  );
  assert.equal(discoveries, 1);
  assert.equal(result.routes.length, 1);
});

test('availability skips disabled routes, missing adapters and unusable discoveries', async () => {
  const withInfo = async (discovered, routes, executable = '/opt/codex') => {
    const policy = delegationCommandPolicy(
      readers({ adapters: { codex: { discover: async () => discovered } } }),
    );
    return policy.availability(
      run({ enabledHarnessRoutes: routes }),
      revision([assignment('codex', executable)]),
    );
  };
  const disabled = await withInfo(info(), []);
  assert.deepEqual(disabled.routes, []);
  const missingAdapter = await delegationCommandPolicy(readers({ adapters: {} })).availability(
    run({ enabledHarnessRoutes: [{ harness: 'codex', executable: '/opt/codex' }] }),
    revision([assignment('codex', '/opt/codex')]),
  );
  assert.deepEqual(missingAdapter.routes, []);
  const enabled = [{ harness: 'codex', executable: '/opt/codex' }];
  for (const [label, discovered] of [
    ['unavailable', info({ available: false })],
    ['unauthenticated', info({ authenticated: false })],
    ['executable mismatch', info({ executable: '/opt/other' })],
    ['versionless', info({ version: '' })],
  ]) {
    const skipped = await withInfo(discovered, enabled);
    assert.deepEqual(skipped.routes, [], `${label} must be skipped`);
  }
});

test('availability throws when discovery rejects or the main identity is incomplete', async () => {
  await assert.rejects(
    delegationCommandPolicy(
      readers({
        adapters: {
          codex: {
            discover: async () => {
              throw new Error('probe failed');
            },
          },
        },
      }),
    ).availability(
      run({ enabledHarnessRoutes: [{ harness: 'codex', executable: '/opt/codex' }] }),
      revision([assignment('codex', '/opt/codex')]),
    ),
    new Error(UNINSPECTABLE),
  );
  await assert.rejects(
    delegationCommandPolicy(readers()).availability(
      run({ executable: undefined }),
      revision([assignment('codex', '/opt/codex')]),
    ),
    new Error(IDENTITY),
  );
  await assert.rejects(
    delegationCommandPolicy(readers()).availability(
      run({ executableVersion: undefined }),
      revision([assignment('codex', '/opt/codex')]),
    ),
    new Error(IDENTITY),
  );
});

test('availability computes commandCapability from runCommand, strict lifecycle and code mode', async () => {
  const capability = async (adapterExtra, discovered) => {
    const result = await delegationCommandPolicy(
      readers({
        adapters: { codex: { discover: async () => discovered, ...adapterExtra } },
      }),
    ).availability(
      run({ enabledHarnessRoutes: [{ harness: 'codex', executable: '/opt/codex' }] }),
      revision([assignment('codex', '/opt/codex')]),
    );
    return result.routes[0];
  };
  const runCommand = { runCommand: async () => undefined };
  assert.equal((await capability(runCommand, info())).commandCapability, true);
  assert.equal((await capability({}, info())).commandCapability, false);
  assert.equal(
    (await capability(runCommand, info({ commandLifecycle: 1 }))).commandCapability,
    false,
  );
  assert.equal(
    (await capability(runCommand, info({ commandLifecycle: undefined }))).commandCapability,
    false,
  );
  assert.equal(
    (await capability(runCommand, info({ executionModes: ['read-only'] }))).commandCapability,
    false,
  );
  const fallback = await capability(runCommand, info({ executionModes: undefined }));
  assert.deepEqual(fallback.modes, ['read-only']);
  assert.equal(fallback.commandCapability, false);
  assert.deepEqual(fallback.models, [{ id: 'model', efforts: ['low'] }]);
});

test('availability carries the retained main selection with a codex default harness', async () => {
  const selection = async (extra) =>
    (await delegationCommandPolicy(readers()).availability(run(extra), revision([]))).mainSelection;
  assert.deepEqual(await selection({}), {
    harness: 'codex',
    executable: '/opt/codex',
    executableVersion: '1',
    model: 'model',
    effort: 'low',
  });
  assert.equal((await selection({ harness: 'grok' })).harness, 'grok');
});

async function fixture(t, seed) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'randolph-delegation-policy-')));
  const store = new Store(root);
  store.putProject({ id: 'project-one', root, createdAt: AT });
  store.putConversation({
    id: 'conversation-one',
    projectId: 'project-one',
    title: 'Delegation',
    createdAt: AT,
    updatedAt: AT,
  });
  for (const value of seed) store.putRun({ ...run({ workspace: root }), ...value });
  store.close();
  const adapter = {
    discover: async () => {
      throw new Error('probe failed');
    },
    run: async () => {
      throw new Error('Must not run');
    },
  };
  const runtime = new Runtime(adapter, root);
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return runtime;
}
const assignmentRecord = (id, role, source, dependencies, extra = {}) => ({
  id,
  task: `${id} task`,
  role,
  harness: 'codex',
  executable: '/opt/codex',
  executableVersion: '1',
  model: 'model',
  effort: 'low',
  rationale: `${id} rationale`,
  dependencies,
  source,
  mode: role === 'main-synthesis' ? 'read-only' : 'code',
  deliverables: [`${id} output`],
  completionCriteria: [`${id} complete`],
  ...extra,
});
const recordPlan = (runtime) =>
  runtime.delegation.records.recordPlan({
    runId: 'run-one',
    revision: 1,
    requestId: 'request-1',
    source: 'proposal',
    basis: { source: 'fixed' },
    plan: {
      schemaVersion: 1,
      id: 'delegation-plan',
      revision: 1,
      limits: { ...defaultDelegationLimits },
      assignments: [
        assignmentRecord('writer', 'worker', 'run-basis', [], { producesSource: true }),
        assignmentRecord('integrate', 'main-integration', 'output:writer', ['writer'], {
          producesSource: true,
          integrationInputs: ['writer'],
        }),
        assignmentRecord('verify', 'runtime-verification', 'output:integrate', ['integrate'], {
          producesSource: true,
        }),
        assignmentRecord('synthesize', 'main-synthesis', 'output:verify', ['verify']),
      ],
    },
  });

test('Runtime reports the busy rejection through the delegation snapshot', async (t) => {
  const runtime = await fixture(t, [{}]);
  runtime.accepting = false;
  const snapshot = await runtime.delegationSnapshot('run-one');
  assert.ok(snapshot.blockedReasons.includes(BUSY), snapshot.blockedReasons.join(' | '));
  assert.equal(snapshot.canEdit, false);
  runtime.accepting = true;
  runtime.admission.add('conversation-one');
  await assert.rejects(
    runtime.rejectDelegation({
      runId: 'run-one',
      planId: 'absent',
      digest: 'absent',
      basisDigest: 'absent',
    }),
    new Error(BUSY),
  );
  runtime.admission.delete('conversation-one');
});

test('Runtime reports the superseded rejection through the delegation snapshot', async (t) => {
  const runtime = await fixture(t, [{}, { id: 'run-two' }]);
  const snapshot = await runtime.delegationSnapshot('run-one');
  assert.ok(snapshot.blockedReasons.includes(SUPERSEDED), snapshot.blockedReasons.join(' | '));
  assert.ok(!(await runtime.delegationSnapshot('run-two')).blockedReasons.includes(SUPERSEDED));
});

test('Runtime reports the unsettled rejection through the delegation snapshot', async (t) => {
  const runtime = await fixture(t, [{ status: 'running' }]);
  const snapshot = await runtime.delegationSnapshot('run-one');
  assert.ok(snapshot.blockedReasons.includes(UNSETTLED), snapshot.blockedReasons.join(' | '));
});

test('Runtime reports the uninspectable-CLI rejection through the delegation snapshot', async (t) => {
  const runtime = await fixture(t, [
    { enabledHarnessRoutes: [{ harness: 'codex', executable: '/opt/codex' }] },
  ]);
  recordPlan(runtime);
  const snapshot = await runtime.delegationSnapshot('run-one');
  assert.ok(
    snapshot.validationErrors.includes(UNINSPECTABLE),
    snapshot.validationErrors.join(' | '),
  );
});

test('Runtime reports the incomplete main identity through the delegation snapshot', async (t) => {
  const runtime = await fixture(t, [{ executable: undefined, executableVersion: undefined }]);
  recordPlan(runtime);
  const snapshot = await runtime.delegationSnapshot('run-one');
  assert.ok(snapshot.validationErrors.includes(IDENTITY), snapshot.validationErrors.join(' | '));
});
