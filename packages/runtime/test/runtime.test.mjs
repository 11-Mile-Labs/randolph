import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { Runtime, Store } from '../dist/index.js';

const harnessInfo = {
  available: true,
  authenticated: true,
  version: 'test-version',
  models: [
    { id: 'model-a', name: 'Model A', efforts: ['low'], defaultEffort: 'low' },
    { id: 'model-b', name: 'Model B', efforts: ['high'], defaultEffort: 'high' },
  ],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeHarnessAdapter {
  constructor({ discover, run } = {}) {
    this.discoverImpl = discover ?? (async () => harnessInfo);
    this.runImpl = run ?? (async () => ({ status: 'completed' }));
    this.discoverCalls = 0;
    this.runCalls = [];
  }

  async discover() {
    this.discoverCalls += 1;
    return this.discoverImpl();
  }

  async run(input) {
    this.runCalls.push(input);
    return this.runImpl(input, this.runCalls.length - 1);
  }
}

function git(root, args) {
  return execFileSync('/usr/bin/git', [
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
    '-C', root,
    ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-runtime-test-'));
  const projectRoot = join(root, 'project');
  const dataRoot = join(root, 'data');
  await mkdir(projectRoot);
  git(projectRoot, ['init', '-b', 'main']);
  await writeFile(join(projectRoot, 'README.md'), '# Synthetic project\n');
  git(projectRoot, ['add', 'README.md']);
  git(projectRoot, ['commit', '-m', 'seed']);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, projectRoot, dataRoot };
}

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function sendInput(conversationId, overrides = {}) {
  return { conversationId, text: 'Inspect the synthetic project.', model: 'model-a', effort: 'low', ...overrides };
}

test('separate conversations can run concurrently', async t => {
  const paths = await fixture(t);
  const gates = [];
  const adapter = new FakeHarnessAdapter({
    run: async () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const first = runtime.createConversation(project.id);
  const second = runtime.createConversation(project.id);

  const [firstRun, secondRun] = await Promise.all([
    runtime.send(sendInput(first.id)),
    runtime.send(sendInput(second.id)),
  ]);

  assert.equal(adapter.runCalls.length, 2);
  assert.notEqual(firstRun.workspace, secondRun.workspace);
  assert.equal(runtime.hasActiveWork(), true);
  for (const gate of gates) gate.resolve({ status: 'completed' });
  await waitFor(() => runtime.snapshot().runs.every(run => run.status === 'completed'));
  await runtime.close();
});

test('duplicate send is rejected while the first send awaits discovery', async t => {
  const paths = await fixture(t);
  const discovery = deferred();
  const adapter = new FakeHarnessAdapter({ discover: async () => discovery.promise });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);

  const firstSend = runtime.send(sendInput(conversation.id));
  await assert.rejects(runtime.send(sendInput(conversation.id)), /already has active work/);
  assert.equal(adapter.discoverCalls, 1);

  discovery.resolve(harnessInfo);
  await firstSend;
  await waitFor(() => runtime.snapshot().runs[0]?.status === 'completed');
  assert.equal(adapter.runCalls.length, 1);
  await runtime.close();
});

test('reopening history never invokes the adapter and marks a prior active run interrupted', async t => {
  const paths = await fixture(t);
  const projectId = randomUUID();
  const conversationId = randomUUID();
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const store = new Store(paths.dataRoot);
  store.transaction(() => {
    store.putProject({ id: projectId, name: 'Synthetic', root: paths.projectRoot, createdAt });
    store.putConversation({ id: conversationId, projectId, title: 'History', model: 'model-a', effort: 'low', createdAt, updatedAt: createdAt, lastReadSequence: 0 });
    store.putRun({ id: runId, projectId, conversationId, status: 'running', model: 'model-a', effort: 'low', workspace: paths.projectRoot, createdAt, updatedAt: createdAt, lastActivityAt: createdAt });
  });
  store.close();

  const adapter = new FakeHarnessAdapter({
    discover: async () => { throw new Error('history must not discover'); },
    run: async () => { throw new Error('history must not run'); },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const recovered = runtime.snapshot().runs.find(run => run.id === runId);

  assert.equal(adapter.discoverCalls, 0);
  assert.equal(adapter.runCalls.length, 0);
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.error, /has not been restarted/);
  assert.equal(runtime.snapshot().events.at(-1).type, 'run.interrupted');
  await runtime.close();
});

test('assistant deltas and transcript roles persist while each run keeps its selected model', async t => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter({
    run: async (input, index) => {
      if (index === 0) {
        input.onEvent({ type: 'message.delta', summary: 'delta', data: { messageId: 'assistant-1', text: 'Read' } });
        input.onEvent({ type: 'message.delta', summary: 'delta', data: { messageId: 'assistant-1', text: ' only.' } });
      }
      return { status: 'completed' };
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);

  await runtime.send(sendInput(conversation.id, { text: 'First message.' }));
  await waitFor(() => runtime.snapshot().runs[0]?.status === 'completed');
  await runtime.send(sendInput(conversation.id, { text: 'Second message.', model: 'model-b', effort: 'high' }));
  await waitFor(() => runtime.snapshot().runs.length === 2 && runtime.snapshot().runs[1].status === 'completed');

  assert.deepEqual(adapter.runCalls[1].messages, [
    { role: 'user', text: 'First message.' },
    { role: 'assistant', text: 'Read only.' },
    { role: 'user', text: 'Second message.' },
  ]);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.messages.find(message => message.role === 'assistant').text, 'Read only.');
  assert.deepEqual(snapshot.runs.map(run => [run.model, run.effort]), [['model-a', 'low'], ['model-b', 'high']]);
  assert.equal(snapshot.conversations[0].model, 'model-b');
  await runtime.close();
});

test('an event arriving during startup cancellation cannot move the run out of stopping', async t => {
  const paths = await fixture(t);
  const entered = deferred();
  const eventAfterAbort = deferred();
  const release = deferred();
  const adapter = new FakeHarnessAdapter({
    run: async input => {
      entered.resolve();
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
      input.onEvent({ type: 'activity', summary: 'late startup event' });
      eventAfterAbort.resolve();
      await release.promise;
      return { status: 'interrupted' };
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);
  const run = await runtime.send(sendInput(conversation.id));
  await entered.promise;

  const stopping = runtime.stop(run.id);
  await eventAfterAbort.promise;
  assert.equal(runtime.snapshot().runs[0].status, 'stopping');
  release.resolve();
  await stopping;
  assert.equal(runtime.snapshot().runs[0].status, 'interrupted');
  await runtime.close();
});

test('a native event append failure rolls back that event and fails the run in SQLite', async t => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter({
    run: async input => {
      input.onEvent({ type: 'native.test', summary: 'must be durable' });
      return { status: 'completed' };
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const originalAppend = runtime.store.append.bind(runtime.store);
  runtime.store.append = (run, type, summary, data) => {
    if (type === 'native.test') throw new Error('native event storage failed');
    return originalAppend(run, type, summary, data);
  };
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);

  await runtime.send(sendInput(conversation.id));
  await waitFor(() => runtime.snapshot().runs[0]?.status === 'failed');
  const snapshot = runtime.snapshot();
  assert.match(snapshot.runs[0].error, /native event storage failed/);
  assert.equal(snapshot.events.some(event => event.type === 'native.test'), false);
  assert.equal(snapshot.events.at(-1).type, 'run.failed');
  await runtime.close();
});

test('failed initial log projection prevents adapter launch while SQLite records failure', async t => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter();
  const runtime = new Runtime(adapter, paths.dataRoot);
  runtime.store.exportRun = () => { throw new Error('projection unavailable'); };
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);

  await assert.rejects(runtime.send(sendInput(conversation.id)), /Could not export run logs/);
  const snapshot = runtime.snapshot();
  assert.equal(adapter.runCalls.length, 0);
  assert.equal(snapshot.runs[0].status, 'failed');
  assert.deepEqual(snapshot.events.map(event => event.type), ['run.created', 'run.failed']);
  await runtime.close();
});
