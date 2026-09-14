import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  defaultDelegationLimits,
  delegationPlanDigest,
  parseDelegationDraft,
  parseDelegationPlan,
  parseDelegationSettings,
  readDelegationSettings,
  validateDelegationPlan,
  writeDelegationSettings,
} from '../dist/delegation-plan.js';

const route = {
  harness: 'grok',
  executable: '/opt/grok',
  version: '1.2.3',
  enabled: true,
  commandCapability: true,
  models: [{ id: 'grok-code', efforts: ['low', 'high'] }],
  modes: ['code', 'read-only'],
};
const availability = {
  routes: [route],
  mainSelection: {
    harness: 'grok',
    executable: '/opt/grok',
    executableVersion: '1.2.3',
    model: 'grok-code',
    effort: 'low',
  },
};
const assignment = (id, role, source, dependencies, extra = {}) => ({
  id,
  task: `${id} task`,
  role,
  harness: 'grok',
  executable: '/opt/grok',
  executableVersion: '1.2.3',
  model: 'grok-code',
  effort: 'low',
  rationale: `${id} rationale`,
  dependencies,
  source,
  mode: role === 'main-synthesis' || role === 'review' ? 'read-only' : 'code',
  deliverables: [`${id} output`],
  completionCriteria: [`${id} done`],
  ...extra,
});
const plan = () => ({
  schemaVersion: 1,
  id: 'fix-widget',
  revision: 1,
  limits: { ...defaultDelegationLimits },
  assignments: [
    assignment('writer', 'worker', 'run-basis', [], { producesSource: true }),
    assignment('integrate', 'main-integration', 'output:writer', ['writer'], {
      producesSource: true,
      integrationInputs: ['writer'],
      repairAttempts: 1,
    }),
    assignment('verify', 'runtime-verification', 'output:integrate', ['integrate'], {
      producesSource: true,
    }),
    assignment('review', 'review', 'output:verify', ['verify']),
    assignment('synthesize', 'main-synthesis', 'output:verify', ['verify', 'review']),
  ],
});
const researchPlan = () => ({
  schemaVersion: 1,
  id: 'research-widget',
  revision: 1,
  limits: { ...defaultDelegationLimits },
  assignments: [
    assignment('researcher', 'worker', 'run-basis', [], {
      mode: 'read-only',
      producesSource: true,
    }),
    assignment('review', 'review', 'output:researcher', ['researcher']),
    assignment('synthesize', 'main-synthesis', 'output:researcher', ['researcher', 'review']),
  ],
});
async function fixture(t) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'randolph-delegation-')));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, path: join(root, 'config.delegation.yaml') };
}

test('a complete bounded plan parses, validates against explicit availability, and has a stable digest', () => {
  const value = parseDelegationPlan(plan());
  const result = validateDelegationPlan(value, availability);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  const reordered = structuredClone(value);
  reordered.assignments[0] = { ...reordered.assignments[0], rationale: 'writer rationale changed' };
  assert.notEqual(delegationPlanDigest(value), delegationPlanDigest(reordered));
  assert.equal(delegationPlanDigest(value), delegationPlanDigest(structuredClone(value)));
});

test('read-only research can include review and settle at synthesis without code integration or native checks', () => {
  const value = parseDelegationPlan(researchPlan());
  assert.deepEqual(validateDelegationPlan(value, availability).errors, []);
});

test('draft parsing preserves bounded graph-invalid proposals while strict parsing rejects them', () => {
  const cyclic = plan();
  cyclic.assignments.find((node) => node.id === 'writer').dependencies = ['synthesize'];
  cyclic.assignments.find((node) => node.id === 'synthesize').dependencies = ['verify', 'writer'];
  assert.equal(parseDelegationDraft(cyclic).id, 'fix-widget');
  assert.throws(() => parseDelegationPlan(cyclic), /acyclic/i);
  assert.throws(
    () =>
      parseDelegationDraft({
        ...cyclic,
        assignments: Array.from({ length: 25 }, () => cyclic.assignments[0]),
      }),
    /1 to 24/i,
  );
  assert.throws(
    () =>
      parseDelegationDraft({
        ...cyclic,
        assignments: cyclic.assignments.map((node) =>
          node.id === 'writer' ? { ...node, executable: 'relative/grok' } : node,
        ),
      }),
    /absolute/i,
  );
});

test('integration requires explicit writer inputs and the final checked lineage covers dependent and parallel code writers', () => {
  const multi = plan();
  multi.assignments.splice(
    1,
    0,
    assignment('writer-b', 'worker', 'output:writer', ['writer'], { producesSource: true }),
  );
  const integrate = multi.assignments.find((node) => node.id === 'integrate');
  integrate.dependencies = ['writer', 'writer-b'];
  integrate.integrationInputs = ['writer', 'writer-b'];
  assert.deepEqual(validateDelegationPlan(parseDelegationPlan(multi), availability).errors, []);
  const missingInput = structuredClone(multi);
  missingInput.assignments.find((node) => node.id === 'integrate').integrationInputs = ['writer'];
  assert.match(
    validateDelegationPlan(missingInput, availability).errors.join('\n'),
    /writer-b.*final integration source lineage/i,
  );
  const implicitInput = structuredClone(multi);
  implicitInput.assignments.find((node) => node.id === 'integrate').dependencies = ['writer'];
  assert.match(
    validateDelegationPlan(implicitInput, availability).errors.join('\n'),
    /explicitly depend on integration input writer-b/i,
  );
  const uncheckedSynthesis = structuredClone(multi);
  uncheckedSynthesis.assignments.find((node) => node.id === 'synthesize').source =
    'output:integrate';
  uncheckedSynthesis.assignments.find((node) => node.id === 'synthesize').dependencies = [
    'integrate',
    'review',
  ];
  assert.match(
    validateDelegationPlan(uncheckedSynthesis, availability).errors.join('\n'),
    /final checked verification output/i,
  );
});

test('validation refuses ambiguity, cycles, unavailable routes, and review before checked output', () => {
  const broken = plan();
  broken.assignments[1].dependencies = [];
  broken.assignments[2].dependencies = ['integrate', 'writer'];
  broken.assignments[3].source = 'output:integrate';
  broken.assignments[3].dependencies = ['integrate'];
  broken.assignments[0].dependencies = ['synthesize'];
  broken.assignments[4].executableVersion = '9.9.9';
  const result = validateDelegationPlan(broken, availability);
  assert.equal(result.valid, false);
  assert.match(
    result.errors.join('\n'),
    /explicitly depend|review.*verification|acyclic|unavailable|disabled/i,
  );
});

test('availability freezes the selected main identity and requires its command-capable route for verification', () => {
  const wrongMain = plan();
  wrongMain.assignments.find((node) => node.id === 'integrate').model = 'other-model';
  const noCommand = { ...availability, routes: [{ ...route, commandCapability: false }] };
  assert.match(
    validateDelegationPlan(wrongMain, availability).errors.join('\n'),
    /frozen selected main-agent/i,
  );
  assert.match(validateDelegationPlan(plan(), noCommand).errors.join('\n'), /command capability/i);
  const wrongVerifier = plan();
  wrongVerifier.assignments.find((node) => node.id === 'verify').executable = '/opt/other-grok';
  assert.match(
    validateDelegationPlan(wrongVerifier, availability).errors.join('\n'),
    /same native harness and executable/i,
  );
});

test('the parser blocks malformed, worker-only, and unbounded plans before a plan revision can be retained', () => {
  for (const invalid of [
    {
      ...plan(),
      assignments: [assignment('only', 'worker', 'run-basis', [], { producesSource: true })],
    },
    { ...plan(), limits: { ...defaultDelegationLimits, maxParallel: 5, maxWorkers: 4 } },
    {
      ...plan(),
      assignments: plan().assignments.map((node) =>
        node.id === 'review'
          ? { ...node, source: 'output:integrate', dependencies: ['integrate'] }
          : node,
      ),
    },
    {
      ...researchPlan(),
      assignments: [
        ...researchPlan().assignments,
        assignment('rogue-code', 'worker', 'run-basis', [], { producesSource: true }),
      ],
    },
    {
      ...plan(),
      assignments: plan().assignments.map((node) =>
        node.id === 'writer' ? { ...node, executable: 'relative/grok' } : node,
      ),
    },
    { ...plan(), unexpectedControl: true },
    {
      ...plan(),
      assignments: plan().assignments.map((node) =>
        node.id === 'writer' ? { ...node, role: ['worker'] } : node,
      ),
    },
    {
      ...plan(),
      assignments: plan().assignments.map((node) =>
        node.id === 'writer' ? { ...node, role: { value: 'worker' } } : node,
      ),
    },
  ])
    assert.throws(() => parseDelegationPlan(invalid));
  assert.throws(() =>
    parseDelegationSettings({
      routing: 'balanced',
      defaultPresetId: null,
      presets: [{ id: 'bad-preset', name: 'Bad preset', revision: 0, plan: plan() }],
    }),
  );
});

test('versioned delegation settings preserve comments and unrelated fields while retaining preset versions', async (t) => {
  const { root, path } = await fixture(t);
  const settings = {
    routing: 'balanced',
    defaultPresetId: 'daily-code',
    presets: [
      {
        id: 'daily-code',
        name: 'Daily code',
        revision: 3,
        plan: plan(),
        importProvenance: { source: 'shared-pack', version: '2026.09' },
      },
    ],
  };
  const first = writeDelegationSettings(root, settings, null);
  assert.deepEqual(readDelegationSettings(root).value, settings);
  const source = `# leave this alone\n${(await readFile(path, 'utf8')).replace('routing: balanced', 'routing: balanced # keep comment')}custom: retained\n`;
  await writeFile(path, source);
  const before = readDelegationSettings(root);
  const saved = writeDelegationSettings(
    root,
    { ...settings, routing: 'thorough' },
    before.revision,
  );
  assert.notEqual(saved.revision, before.revision);
  const text = await readFile(path, 'utf8');
  assert.match(text, /# leave this alone/);
  assert.match(text, /# keep comment/);
  assert.match(text, /custom: retained/);
  assert.match(text, /routing: thorough/);
  await writeFile(path, source);
  assert.throws(() => writeDelegationSettings(root, settings, first.revision), /changed|reload/i);
  assert.equal(await readFile(path, 'utf8'), source);
  const cleared = writeDelegationSettings(
    root,
    { ...settings, defaultPresetId: null },
    before.revision,
  );
  assert.equal(cleared.value.defaultPresetId, null);
  assert.match(await readFile(path, 'utf8'), /defaultPresetId: null/);
});

test('invalid external YAML stays visible and is never overwritten', async (t) => {
  const { root, path } = await fixture(t);
  const source = 'schemaVersion: 1\nrouting: unsafe\npresets: []\n';
  await writeFile(path, source);
  const current = readDelegationSettings(root);
  assert.ok(current.error);
  assert.equal(current.revision, createHash('sha256').update(source).digest('hex'));
  assert.throws(() =>
    writeDelegationSettings(root, { routing: 'balanced', presets: [] }, current.revision),
  );
  assert.equal(await readFile(path, 'utf8'), source);
});

test('missing delegation settings use the balanced, no-preset default', async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(readDelegationSettings(root).value, {
    routing: 'balanced',
    defaultPresetId: null,
    presets: [],
  });
});
