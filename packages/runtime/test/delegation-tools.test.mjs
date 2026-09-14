import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { createDelegationTools } from '../dist/delegation-tools.js';
import { defaultDelegationLimits } from '../dist/delegation-plan.js';

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
  mode: role === 'review' || role === 'main-synthesis' ? 'read-only' : 'code',
  deliverables: [`${id} output`],
  completionCriteria: [`${id} complete`],
  ...extra,
});
const plan = (revision = 1) => ({
  schemaVersion: 1,
  id: 'proposal',
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
function addRun(store, id, projectId, conversationId) {
  store.putProject({
    id: projectId,
    root: `/tmp/${projectId}`,
    createdAt: '2026-09-12T00:00:00.000Z',
  });
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
    workspace: `/tmp/${id}`,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    lastActivityAt: '2026-09-12T00:00:00.000Z',
  });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-delegation-tools-'));
  const store = new Store(root);
  addRun(store, 'run-one', 'project-one', 'conversation-one');
  addRun(store, 'run-two', 'project-two', 'conversation-two');
  const records = new DelegationRecords(store);
  records.recordSession({
    id: 'main-one',
    runId: 'run-one',
    role: 'main',
    harness: 'grok',
    executable: '/opt/grok',
    executableVersion: '1',
    model: 'model',
    effort: 'low',
    allowedTools: ['randolph_propose_delegation', 'randolph_read_tasks'],
    state: 'prepared',
  });
  records.bindSession({
    runId: 'run-one',
    sessionId: 'main-one',
    threadId: 'thread-one',
    turnId: 'turn-one',
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const tools = createDelegationTools(records, {
    runId: 'run-one',
    sessionId: 'main-one',
    requestId: 'registered-request',
    basis: { runBasis: 'basis-one' },
    availability,
  });
  const request = (name, argumentsValue, extra = {}) => ({
    threadId: 'thread-one',
    turnId: 'turn-one',
    callId: 'call-one',
    requestId: 0,
    name,
    arguments: argumentsValue,
    ...extra,
  });
  return { store, records, tools, request };
}

test('proposal records one atomic draft and exactly replays its native tool identity', async (t) => {
  const { records, tools, request } = await fixture(t);
  const first = tools.onRequest(request('randolph_propose_delegation', { plan: plan() }));
  const replay = tools.onRequest(request('randolph_propose_delegation', { plan: plan() }));
  assert.equal(first.success, true);
  assert.equal(replay.text, first.text);
  assert.equal(records.plans('run-one').length, 1);
  const result = JSON.parse(first.text);
  assert.equal(result.disposition, 'draft');
  assert.equal(result.approvalReady, false);
  assert.equal(records.authorizations('run-one').length, 0);
  assert.equal(records.tasks('run-one').length, 0);
});

test('the frozen selected-main route is validated and invalid capability drafts remain unauthorised', async (t) => {
  const { records, tools, request } = await fixture(t);
  const invalid = plan();
  invalid.assignments.find((item) => item.id === 'synthesize').model = 'other-model';
  const result = tools.onRequest(request('randolph_propose_delegation', { plan: invalid }));
  const body = JSON.parse(result.text);
  assert.equal(result.success, true);
  assert.match(body.validationErrors.join('\n'), /frozen selected main-agent|unavailable model/i);
  assert.equal(records.plans('run-one').length, 1);
  assert.equal(records.authorizations('run-one').length, 0);
  assert.equal(records.tasks('run-one').length, 0);
});

test('tool arguments cannot inject another run or project scope', async (t) => {
  const { records, tools, request } = await fixture(t);
  const result = tools.onRequest(
    request('randolph_propose_delegation', { plan: plan(), runId: 'run-two' }),
  );
  assert.equal(result.success, false);
  assert.match(result.text, /only the plan/i);
  assert.equal(records.plans('run-one').length, 0);
  assert.equal(records.plans('run-two').length, 0);
});

test('same-run task reads are bounded and reject an unknown retained task', async (t) => {
  const { records, tools, request } = await fixture(t);
  const proposal = tools.onRequest(request('randolph_propose_delegation', { plan: plan() }));
  const retained = JSON.parse(proposal.text);
  records.finishSession({
    runId: 'run-one',
    sessionId: 'main-one',
    status: 'completed',
    cleanupConfirmed: true,
    cleanupEvidence: { processExit: true },
  });
  const ready = records.readyPlan({
    runId: 'run-one',
    planId: retained.planId,
    digest: retained.digest,
    basisDigest: records.plans('run-one')[0].basisDigest,
  });
  const authorization = records.authorize({
    runId: 'run-one',
    planId: ready.id,
    digest: ready.digest,
    basisDigest: ready.basisDigest,
    decision: 'user',
    presetSaved: false,
  });
  const tasks = records.createTasks({ runId: 'run-one', authorizationId: authorization.id });
  records.recordSession({
    id: 'main-two',
    runId: 'run-one',
    role: 'main',
    harness: 'grok',
    executable: '/opt/grok',
    executableVersion: '1',
    model: 'model',
    effort: 'low',
    allowedTools: ['randolph_read_tasks'],
    state: 'prepared',
  });
  records.bindSession({
    runId: 'run-one',
    sessionId: 'main-two',
    threadId: 'thread-two',
    turnId: 'turn-two',
  });
  const reads = createDelegationTools(records, {
    runId: 'run-one',
    sessionId: 'main-two',
    requestId: 'read-request',
    basis: { runBasis: 'basis-one' },
    availability,
  });
  const valid = reads.onRequest({
    threadId: 'thread-two',
    turnId: 'turn-two',
    callId: 'read-call',
    requestId: 'read-0',
    name: 'randolph_read_tasks',
    arguments: { taskIds: [tasks[0].id] },
  });
  assert.equal(JSON.parse(valid.text).tasks.length, 1);
  const unknown = reads.onRequest({
    threadId: 'thread-two',
    turnId: 'turn-two',
    callId: 'read-unknown',
    requestId: 'read-1',
    name: 'randolph_read_tasks',
    arguments: { taskIds: ['run-two:forged'] },
  });
  assert.equal(unknown.success, false);
  assert.match(unknown.text, /not retained in this run/i);
});

test('stopped runs and mismatched native sessions are denied before broker mutation', async (t) => {
  const { store, records, tools, request } = await fixture(t);
  const run = store.runs().find((item) => item.id === 'run-one');
  run.status = 'completed';
  store.putRun(run);
  assert.throws(
    () => tools.onRequest(request('randolph_propose_delegation', { plan: plan() })),
    /not active/i,
  );
  assert.equal(records.plans('run-one').length, 0);
  run.status = 'running';
  store.putRun(run);
  assert.throws(
    () =>
      tools.onRequest(
        request(
          'randolph_propose_delegation',
          { plan: plan() },
          { turnId: 'forged-turn', callId: 'forged-call', requestId: 'forged-request' },
        ),
      ),
    /bound main session/i,
  );
  assert.equal(records.plans('run-one').length, 0);
});

test('broker freezes caller-owned configuration and requires a selected main identity', async (t) => {
  const { records, request } = await fixture(t);
  const scope = {
    runId: 'run-one',
    sessionId: 'main-one',
    requestId: 'request',
    basis: { runBasis: 'original' },
    availability: structuredClone(availability),
  };
  const tools = createDelegationTools(records, scope);
  scope.runId = 'run-two';
  scope.basis.runBasis = 'changed';
  scope.availability.mainSelection.model = 'changed';
  const receipt = tools.onRequest(request('randolph_propose_delegation', { plan: plan() }));
  assert.deepEqual(JSON.parse(receipt.text).validationErrors, []);
  assert.equal(records.plans('run-one')[0].basis.runBasis, 'original');
  assert.equal(records.plans('run-two').length, 0);
  assert.throws(
    () => createDelegationTools(records, { ...scope, availability: { routes: [] } }),
    /frozen main selection/,
  );
});

test('graph-invalid proposals remain editable drafts with bounded validation receipts', async (t) => {
  const { records, tools, request } = await fixture(t);
  const invalid = plan();
  invalid.assignments[0].dependencies = ['synthesize'];
  const response = tools.onRequest(request('randolph_propose_delegation', { plan: invalid }));
  assert.equal(response.success, true);
  assert.match(JSON.parse(response.text).validationErrors.join(' '), /acyclic/);
  assert.equal(records.plans('run-one')[0].plan.assignments[0].dependencies[0], 'synthesize');
  const huge = plan(2);
  huge.assignments = Array.from({ length: 24 }, (_, index) =>
    assignment(
      `node-${index}-${'n'.repeat(70)}`,
      index === 23 ? 'main-synthesis' : 'worker',
      'run-basis',
      Array.from({ length: 16 }, (_, dependency) => `missing-${dependency}-${'m'.repeat(65)}`),
      { mode: 'read-only' },
    ),
  );
  assert.ok(Buffer.byteLength(JSON.stringify({ plan: huge })) < 64 * 1024);
  const largeResponse = tools.onRequest(
    request('randolph_propose_delegation', { plan: huge }, { callId: 'huge', requestId: 1 }),
  );
  const body = JSON.parse(largeResponse.text);
  assert.equal(largeResponse.success, true);
  assert.equal(body.validationErrorsTruncated, true);
  assert.ok(body.validationErrorCount > body.validationErrors.length);
  assert.ok(Buffer.byteLength(JSON.stringify(largeResponse)) < 64 * 1024);
  assert.equal(records.plans('run-one').length, 2);
  assert.equal(records.authorizations('run-one').length, 0);
});

test('large retained task results return an honest bounded subset', () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index}`,
    assignmentId: `assignment-${index}`,
    state: 'failed',
    dependencies: [],
    attempts: Array.from({ length: 10 }, (_, generation) => ({
      id: `attempt-${generation}`,
      generation,
      status: 'failed',
      error: '\\"'.repeat(500),
    })),
  }));
  const records = {
    tasks: () => tasks,
    recordToolReceipt: (_input, mutate) => {
      const receipt = mutate();
      assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 64 * 1024);
      return { receipt: { receipt } };
    },
  };
  const tools = createDelegationTools(records, {
    runId: 'run',
    sessionId: 'session',
    requestId: 'request',
    basis: {},
    availability,
  });
  const receipt = tools.onRequest({
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    requestId: 0,
    name: 'randolph_read_tasks',
    arguments: {},
  });
  const result = JSON.parse(receipt.text);
  assert.equal(receipt.success, true);
  assert.equal(result.total, 25);
  assert.equal(result.truncated, true);
  assert.ok(result.tasks.length > 0 && result.tasks.length < 25);
  assert.ok(Buffer.byteLength(receipt.text) < 64 * 1024);
  const selected = JSON.parse(
    tools.onRequest({
      threadId: 'thread',
      turnId: 'turn',
      callId: 'next',
      requestId: 1,
      name: 'randolph_read_tasks',
      arguments: { taskIds: ['task-24'] },
    }).text,
  );
  assert.equal(selected.truncated, false);
  assert.equal(selected.tasks[0].id, 'task-24');
});
