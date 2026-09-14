import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import { DelegationCommands } from '../dist/delegation-commands.js';
import { readDelegationSettings, defaultDelegationLimits } from '../dist/delegation-plan.js';
import { Store } from '../dist/store.js';

const route = {
  harness: 'grok',
  executable: '/opt/grok',
  version: '1',
  enabled: true,
  commandCapability: true,
  models: [{ id: 'model', efforts: ['low'] }],
  modes: ['code', 'read-only'],
};
const availability = {
  routes: [route],
  mainSelection: {
    harness: 'grok',
    executable: '/opt/grok',
    executableVersion: '1',
    model: 'model',
    effort: 'low',
  },
};
const assignment = (id, role, source, dependencies, extra = {}) => ({
  id,
  task: `${id} task`,
  role,
  harness: 'grok',
  executable: '/opt/grok',
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
const plan = (revision) => ({
  schemaVersion: 1,
  id: 'delegation-plan',
  revision,
  limits: { ...defaultDelegationLimits },
  assignments: [
    assignment('writer', 'worker', 'run-basis', [], { producesSource: true }),
    assignment('integrate', 'main-integration', 'output:writer', ['writer'], {
      producesSource: true,
      integrationInputs: ['writer'],
    }),
    assignment('verify', 'runtime-verification', 'output:integrate', ['integrate'], {
      producesSource: true,
    }),
    assignment('synthesize', 'main-synthesis', 'output:verify', ['verify']),
  ],
});
function addRun(
  store,
  root,
  id = 'run-one',
  projectId = 'project-one',
  conversationId = 'conversation-one',
) {
  store.putProject({ id: projectId, root, createdAt: '2026-09-12T00:00:00.000Z' });
  store.putConversation({
    id: conversationId,
    projectId,
    title: 'Delegation',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  });
  store.putRun({
    id,
    projectId,
    conversationId,
    status: 'running',
    model: 'model',
    effort: 'low',
    workspace: root,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    lastActivityAt: '2026-09-12T00:00:00.000Z',
  });
}
async function fixture(t, options = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'randolph-delegation-commands-'))),
    store = new Store(root);
  addRun(store, root);
  let mutable = true,
    basis = true,
    changes = 0;
  const queued = [];
  const policy = {
    assertMutable: () => {
      if (!mutable) throw new Error('Run action changed.');
    },
    assertBasis: () => {
      if (!basis) throw new Error('Source basis changed.');
    },
    availability: async () => (options.availability ? options.availability() : availability),
    ...(options.execution === false
      ? {}
      : {
          execution: {
            assertReady: () => {
              if (options.ready === false) throw new Error('Scheduler unavailable.');
            },
            queued: (runId) => queued.push(runId),
          },
        }),
  };
  const commands = new DelegationCommands(store, policy, () => {
    changes += 1;
  });
  t.after(async () => {
    try {
      store.close();
    } catch {
      /* Reopen recovery tests close the original handle. */
    }
    await rm(root, { recursive: true, force: true });
  });
  const record = (revision = 1, inputPlan = plan(revision)) =>
    commands.records.recordPlan({
      runId: 'run-one',
      revision,
      requestId: `request-${revision}`,
      source: 'proposal',
      basis: { source: 'fixed' },
      plan: inputPlan,
    });
  const ready = (revision = 1, inputPlan = plan(revision)) => {
    const value = record(revision, inputPlan);
    return commands.records.readyPlan({
      runId: value.runId,
      planId: value.id,
      digest: value.digest,
      basisDigest: value.basisDigest,
    });
  };
  return {
    root,
    store,
    policy,
    commands,
    record,
    ready,
    queued,
    changes: () => changes,
    setMutable: (value) => {
      mutable = value;
    },
    setBasis: (value) => {
      basis = value;
    },
  };
}
const exact = (record) => ({
  runId: record.runId,
  planId: record.id,
  digest: record.digest,
  basisDigest: record.basisDigest,
});

test('revision commands require the exact current plan identity and retain a separate rejection', async (t) => {
  const { commands, ready, record } = await fixture(t);
  const first = ready();
  for (const input of [
    { ...exact(first), digest: '0'.repeat(64) },
    { ...exact(first), basisDigest: '1'.repeat(64) },
    { ...exact(first), runId: 'other-run' },
  ])
    await assert.rejects(commands.reject(input), /changed|does not exist/i);
  const revised = await commands.revise({ ...exact(first), plan: plan(99) });
  assert.equal(revised.plan.revision, 2);
  assert.equal(revised.plan.plan.revision, 2);
  assert.equal(commands.records.authorizations('run-one').length, 0);
  await commands.reject(exact(revised.plan));
  assert.equal(commands.records.plans('run-one').at(-1).disposition, 'rejected');
  const later = record(3);
  assert.equal(later.revision, 3);
});

test('a graph-invalid revision remains editable and cannot become ready or authorize', async (t) => {
  const { commands, ready } = await fixture(t);
  const initial = ready();
  const invalid = plan(2);
  invalid.assignments.find((node) => node.id === 'writer').dependencies = ['synthesize'];
  invalid.assignments.find((node) => node.id === 'synthesize').dependencies = ['verify', 'writer'];
  const snapshot = await commands.revise({ ...exact(initial), plan: invalid });
  assert.equal(snapshot.plan.disposition, 'draft');
  assert.match(snapshot.validationErrors.join(' '), /acyclic/i);
  await assert.rejects(commands.approve(exact(snapshot.plan)), /not actionable|ready|acyclic/i);
  assert.equal(commands.records.authorizations('run-one').length, 0);
});

test('authorized and rejected snapshots do not probe availability', async (t) => {
  let probes = 0,
    forbidProbe = false;
  const unavailable = async () => {
    probes += 1;
    if (forbidProbe) throw new Error('availability must not be called for historical plans');
    return availability;
  };
  const authorizedFixture = await fixture(t, { availability: unavailable });
  const authorized = authorizedFixture.ready();
  await authorizedFixture.commands.approve(exact(authorized));
  const authorizedTaskIds = authorizedFixture.commands.records
    .tasks('run-one')
    .map((task) => task.id);
  probes = 0;
  forbidProbe = true;
  const authorizedSnapshot = await authorizedFixture.commands.snapshot('run-one');
  assert.equal(probes, 0);
  assert.equal(authorizedSnapshot.canApprove, false);
  assert.deepEqual(
    authorizedSnapshot.tasks.map((task) => task.id),
    authorizedTaskIds,
  );
  assert.deepEqual(
    authorizedSnapshot.history.map((item) => item.disposition),
    ['authorized'],
  );

  let rejectedProbes = 0,
    rejectedForbidProbe = false;
  const rejectedFixture = await fixture(t, {
    availability: async () => {
      rejectedProbes += 1;
      if (rejectedForbidProbe)
        throw new Error('availability must not be called for rejected plans');
      return availability;
    },
  });
  const rejected = rejectedFixture.ready();
  rejectedForbidProbe = true;
  const rejectedSnapshot = await rejectedFixture.commands.reject(exact(rejected));
  assert.equal(rejectedProbes, 0);
  assert.equal(rejectedSnapshot.canApprove, false);
  assert.deepEqual(rejectedSnapshot.tasks, []);
  assert.deepEqual(
    rejectedSnapshot.history.map((item) => item.disposition),
    ['rejected'],
  );
});

test('preset writes preserve unrelated YAML, exactly replay, reject changed payloads, and never authorize', async (t) => {
  const { root, commands, ready } = await fixture(t);
  const value = ready();
  await writeFile(
    join(root, 'config.delegation.yaml'),
    'schemaVersion: 1\nrouting: balanced\ndefaultPresetId: null\npresets: []\ncustom: retained\n',
  );
  const current = readDelegationSettings(root);
  const input = {
    ...exact(value),
    presetId: 'daily-code',
    name: 'Daily code',
    expectedSettingsRevision: current.revision,
  };
  const saved = await commands.savePreset(input);
  assert.equal(saved.settings.value.presets[0].id, 'daily-code');
  assert.equal(commands.records.authorizations('run-one').length, 0);
  assert.match(await readFile(join(root, 'config.delegation.yaml'), 'utf8'), /custom: retained/);
  const once = commands.records.presetSaves('run-one').length;
  await commands.savePreset(input);
  assert.equal(commands.records.presetSaves('run-one').length, once);
  await assert.rejects(
    commands.savePreset({ ...input, name: 'Changed daily code' }),
    /settings changed/i,
  );
});

test('an exact retry repairs a receipt failure after the YAML write without rewriting or incrementing the preset', async (t) => {
  const { root, commands, ready } = await fixture(t);
  const value = ready();
  await writeFile(
    join(root, 'config.delegation.yaml'),
    'schemaVersion: 1\nrouting: balanced\ndefaultPresetId: null\npresets: []\n',
  );
  const input = {
    ...exact(value),
    presetId: 'daily-code',
    name: 'Daily code',
    expectedSettingsRevision: readDelegationSettings(root).revision,
  };
  const original = commands.records.recordPresetSave;
  commands.records.recordPresetSave = () => {
    throw new Error('receipt database failed');
  };
  await assert.rejects(commands.savePreset(input), /written.*receipt.*unconfirmed/i);
  commands.records.recordPresetSave = original;
  const path = join(root, 'config.delegation.yaml'),
    before = await readFile(path, 'utf8'),
    beforeStat = await stat(path);
  assert.equal(readDelegationSettings(root).value.presets[0].revision, 1);
  assert.equal(commands.records.presetSaves('run-one').length, 0);
  assert.equal(commands.records.authorizations('run-one').length, 0);
  assert.equal(
    commands.store.events('run-one').filter((event) => event.type === 'delegation.preset-saved')
      .length,
    0,
  );
  await commands.savePreset(input);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await stat(path)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(readDelegationSettings(root).value.presets[0].revision, 1);
  assert.equal(commands.records.presetSaves('run-one').length, 1);
  await commands.savePreset(input);
  assert.equal(commands.records.presetSaves('run-one').length, 1);
  assert.equal(commands.records.authorizations('run-one').length, 0);
});

test('reopening reconciles an exact pending preset receipt without inference or execution', async (t) => {
  const { root, store, policy, commands, ready, queued } = await fixture(t);
  const value = ready();
  const input = {
    ...exact(value),
    presetId: 'recovered-preset',
    name: 'Recovered preset',
    expectedSettingsRevision: null,
  };
  const original = commands.records.recordPresetSave;
  commands.records.recordPresetSave = () => {
    throw new Error('receipt database failed');
  };
  await assert.rejects(commands.savePreset(input), /receipt.*unconfirmed/i);
  commands.records.recordPresetSave = original;
  store.close();
  const reopenedStore = new Store(root),
    reopened = new DelegationCommands(reopenedStore, policy, () => {});
  t.after(() => reopenedStore.close());
  const snapshot = await reopened.snapshot('run-one');
  assert.equal(snapshot.presetSaveWarnings.length, 0);
  assert.equal(reopened.records.presetSaves('run-one').length, 1);
  assert.equal(reopened.records.authorizations('run-one').length, 0);
  assert.deepEqual(queued, []);
  await reopened.snapshot('run-one');
  assert.equal(reopened.records.presetSaves('run-one').length, 1);
});

test('tampered settings keep a pending preset receipt visible without overwriting or falsely reconciling it', async (t) => {
  const { root, commands, ready, queued } = await fixture(t);
  const value = ready();
  const input = {
    ...exact(value),
    presetId: 'daily-code',
    name: 'Daily code',
    expectedSettingsRevision: null,
  };
  const original = commands.records.recordPresetSave;
  commands.records.recordPresetSave = () => {
    throw new Error('receipt database failed');
  };
  await assert.rejects(commands.savePreset(input), /receipt.*unconfirmed/i);
  commands.records.recordPresetSave = original;
  const path = join(root, 'config.delegation.yaml'),
    saved = await readFile(path, 'utf8'),
    tampered = saved.replace('routing: balanced', 'routing: thorough');
  await writeFile(path, tampered);
  const snapshot = await commands.snapshot('run-one');
  assert.ok(snapshot.presetSaveWarnings.length);
  assert.equal(commands.records.presetSaves('run-one').length, 0);
  assert.equal(await readFile(path, 'utf8'), tampered);
  assert.equal(commands.records.authorizations('run-one').length, 0);
  assert.deepEqual(queued, []);
});

test('an explicit newer preset save supersedes an older unconfirmed intent', async (t) => {
  const { root, commands, ready } = await fixture(t);
  const value = ready();
  const first = {
    ...exact(value),
    presetId: 'daily-code',
    name: 'Daily code',
    expectedSettingsRevision: null,
  };
  const original = commands.records.recordPresetSave;
  commands.records.recordPresetSave = () => {
    throw new Error('receipt database failed');
  };
  await assert.rejects(commands.savePreset(first), /receipt.*unconfirmed/i);
  commands.records.recordPresetSave = original;
  const current = readDelegationSettings(root);
  const second = {
    ...first,
    name: 'Updated daily code',
    expectedSettingsRevision: current.revision,
  };
  await commands.savePreset(second);
  assert.equal(readDelegationSettings(root).value.presets[0].revision, 2);
  assert.equal(commands.records.presetSaves('run-one').length, 1);
  assert.equal(
    commands.store
      .events('run-one')
      .filter((event) => event.type === 'delegation.preset-save-superseded').length,
    1,
  );
  assert.equal((await commands.snapshot('run-one')).presetSaveWarnings.length, 0);
});

test('approval refuses unavailable capability and a build without an execution admission callback', async (t) => {
  const disabled = await fixture(t, {
    availability: async () => ({ ...availability, routes: [{ ...route, enabled: false }] }),
  });
  const value = disabled.ready();
  await assert.rejects(disabled.commands.approve(exact(value)), /unavailable|disabled/i);
  assert.equal(disabled.commands.records.authorizations('run-one').length, 0);
  const noExecution = await fixture(t, { execution: false });
  const other = noExecution.ready();
  await assert.rejects(noExecution.commands.approve(exact(other)), /not enabled/i);
  assert.equal(noExecution.commands.records.authorizations('run-one').length, 0);
});

test('async availability cannot authorize after a newer proposal or changed run action', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const race = await fixture(t, {
    availability: async () => {
      await pending;
      return availability;
    },
  });
  const current = race.ready();
  const approval = race.commands.approve(exact(current));
  await new Promise((resolve) => setImmediate(resolve));
  race.record(2);
  release();
  await assert.rejects(approval, /changed|actionable/i);
  assert.equal(race.commands.records.authorizations('run-one').length, 0);

  let next;
  const delayed = new Promise((resolve) => {
    next = resolve;
  });
  const action = await fixture(t, {
    availability: async () => {
      await delayed;
      return availability;
    },
  });
  const second = action.ready();
  const blocked = action.commands.approve(exact(second));
  await new Promise((resolve) => setImmediate(resolve));
  action.setMutable(false);
  next();
  await assert.rejects(blocked, /Run action changed/i);
  assert.equal(action.commands.records.authorizations('run-one').length, 0);
});

test('explicit approval atomically authorizes the full graph, queues once, and refuses a duplicate', async (t) => {
  const { commands, ready, queued, changes } = await fixture(t);
  const value = ready();
  const snapshot = await commands.approve(exact(value));
  assert.equal(snapshot.plan.disposition, 'authorized');
  assert.equal(commands.records.authorizations('run-one').length, 1);
  assert.deepEqual(
    new Set(commands.records.tasks('run-one').map((task) => task.assignmentId)),
    new Set(plan(1).assignments.map((assignment) => assignment.id)),
  );
  assert.deepEqual(queued, ['run-one']);
  assert.ok(changes() >= 1);
  await assert.rejects(commands.approve(exact(value)), /changed|actionable/i);
  assert.equal(commands.records.authorizations('run-one').length, 1);
  assert.deepEqual(queued, ['run-one']);
});
