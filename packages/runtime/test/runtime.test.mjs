import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { Runtime, Store } from '../dist/index.js';
import { AdapterRunFailure } from '../dist/contracts.js';

const harnessInfo = {
  executable: '/fixture-codex',
  available: true,
  authenticated: true,
  cleanupVerified: true,
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

  async discover(executable, signal) {
    this.discoverCalls += 1;
    return this.discoverImpl(executable, signal);
  }

  async run(input) {
    this.runCalls.push(input);
    const result = await this.runImpl(input, this.runCalls.length - 1);
    if (result.status !== 'stop-unconfirmed')
      input.onEvent({
        type: 'session.turn-started',
        summary: 'fixture turn established',
        data: {
          threadId: `fixture-thread-${this.runCalls.length}`,
          turnId: `fixture-turn-${this.runCalls.length}`,
        },
      });
    return result;
  }
}

function git(root, args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
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
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, projectRoot, dataRoot };
}

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function sendInput(conversationId, overrides = {}) {
  return {
    conversationId,
    text: 'Inspect the synthetic project.',
    model: 'model-a',
    effort: 'low',
    ...overrides,
  };
}

test('separate conversations can run concurrently', async (t) => {
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
  await waitFor(() => runtime.snapshot().runs.every((run) => run.status === 'completed'));
  await runtime.close();
});

test('duplicate send is rejected while the first send awaits discovery', async (t) => {
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

test('discovery counts as active work and close waits for its aborted transport to settle', async (t) => {
  const paths = await fixture(t);
  let abortObserved = false;
  let releaseDiscovery;
  const adapter = new FakeHarnessAdapter({
    discover: async (_executable, signal) => {
      await new Promise((resolve) => {
        releaseDiscovery = resolve;
        if (signal.aborted) {
          abortObserved = true;
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            abortObserved = true;
          },
          { once: true },
        );
      });
      return {
        available: false,
        authenticated: false,
        cleanupVerified: true,
        models: [],
        reason: 'Discovery cancelled by close.',
      };
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);
  const sending = runtime.send(sendInput(conversation.id));
  await waitFor(() => adapter.discoverCalls === 1);
  assert.equal(runtime.hasActiveWork(), true);
  let closed = false;
  assert.equal(runtime.hasActiveWork({ includeDiscovery: false }), true);
  const closing = (async () => {
    await runtime.close();
    closed = true;
  })();
  await waitFor(() => abortObserved, 'close did not abort discovery');
  assert.equal(closed, false);
  releaseDiscovery();
  await closing;
  await assert.rejects(sending, /cancelled|available|authenticated/i);
});

test('reopening history never invokes the adapter and marks a prior active run interrupted', async (t) => {
  const paths = await fixture(t);
  const projectId = randomUUID();
  const conversationId = randomUUID();
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const store = new Store(paths.dataRoot);
  store.transaction(() => {
    store.putProject({ id: projectId, name: 'Synthetic', root: paths.projectRoot, createdAt });
    store.putConversation({
      id: conversationId,
      projectId,
      title: 'History',
      model: 'model-a',
      effort: 'low',
      createdAt,
      updatedAt: createdAt,
      lastReadSequence: 0,
    });
    store.putRun({
      id: runId,
      projectId,
      conversationId,
      status: 'running',
      model: 'model-a',
      effort: 'low',
      workspace: paths.projectRoot,
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
    });
  });
  store.close();

  const adapter = new FakeHarnessAdapter({
    discover: async () => {
      throw new Error('history must not discover');
    },
    run: async () => {
      throw new Error('history must not run');
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const recovered = runtime.snapshot().runs.find((run) => run.id === runId);

  assert.equal(adapter.discoverCalls, 0);
  assert.equal(adapter.runCalls.length, 0);
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.error, /has not been restarted/);
  assert.equal(runtime.snapshot().events.at(-1).type, 'run.interrupted');
  await runtime.close();
});

test('assistant deltas and transcript roles persist while each run keeps its selected model', async (t) => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter({
    run: async (input, index) => {
      if (index === 0) {
        input.onEvent({
          type: 'message.delta',
          summary: 'delta',
          data: { messageId: 'assistant-1', text: 'Read' },
        });
        input.onEvent({
          type: 'message.delta',
          summary: 'delta',
          data: { messageId: 'assistant-1', text: ' only.' },
        });
      }
      return { status: 'completed' };
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);

  await runtime.send(sendInput(conversation.id, { text: 'First message.' }));
  await waitFor(() => runtime.snapshot().runs[0]?.status === 'completed');
  await runtime.send(
    sendInput(conversation.id, { text: 'Second message.', model: 'model-b', effort: 'high' }),
  );
  await waitFor(
    () => runtime.snapshot().runs.length === 2 && runtime.snapshot().runs[1].status === 'completed',
  );

  assert.deepEqual(adapter.runCalls[1].messages, [
    { role: 'user', text: 'First message.' },
    { role: 'assistant', text: 'Read only.' },
    { role: 'user', text: 'Second message.' },
  ]);
  const snapshot = runtime.snapshot();
  assert.equal(
    snapshot.messages.find((message) => message.role === 'assistant').text,
    'Read only.',
  );
  assert.deepEqual(
    snapshot.runs.map((run) => [run.model, run.effort]),
    [
      ['model-a', 'low'],
      ['model-b', 'high'],
    ],
  );
  assert.equal(snapshot.conversations[0].model, 'model-b');
  await runtime.close();
});

test('an event arriving during startup cancellation cannot move the run out of stopping', async (t) => {
  const paths = await fixture(t);
  const entered = deferred();
  const eventAfterAbort = deferred();
  const release = deferred();
  const adapter = new FakeHarnessAdapter({
    run: async (input) => {
      entered.resolve();
      await new Promise((resolve) =>
        input.signal.addEventListener('abort', resolve, { once: true }),
      );
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

test('a native event append failure rolls back that event and fails the run in SQLite', async (t) => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter({
    run: async (input) => {
      try {
        input.onEvent({ type: 'native.test', summary: 'must be durable' });
      } catch (error) {
        throw new AdapterRunFailure(error.message, { fixtureProcesses: 'none-launched' });
      }
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
  assert.equal(
    snapshot.events.some((event) => event.type === 'native.test'),
    false,
  );
  assert.equal(snapshot.events.at(-1).type, 'run.failed');
  await runtime.close();
});

test('failed initial log projection prevents adapter launch while SQLite records failure', async (t) => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter();
  const runtime = new Runtime(adapter, paths.dataRoot);
  runtime.store.exportRun = () => {
    throw new Error('projection unavailable');
  };
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);

  await assert.rejects(runtime.send(sendInput(conversation.id)), /Could not export run logs/);
  const snapshot = runtime.snapshot();
  assert.equal(adapter.runCalls.length, 0);
  assert.equal(snapshot.runs[0].status, 'failed');
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    ['run.created', 'run.failed'],
  );
  await runtime.close();
});

test('project defaults and unsent conversation overrides survive reopening without starting work', async (t) => {
  const paths = await fixture(t);
  let runtime = new Runtime(new FakeHarnessAdapter(), paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const inherited = runtime.createConversation(project.id);
  const overridden = runtime.createConversation(project.id);
  await runtime.saveProjectDefaults({
    projectId: project.id,
    defaults: { harness: 'codex', model: 'model-b', effort: 'high' },
    expectedRevision: null,
  });
  await runtime.setConversationSelection({
    conversationId: overridden.id,
    selection: { harness: 'codex', model: 'model-a', effort: 'low' },
  });
  await runtime.close();

  const adapter = new FakeHarnessAdapter();
  runtime = new Runtime(adapter, paths.dataRoot);
  assert.equal(runtime.snapshot().projects[0].harnessSettings.defaults.model, 'model-b');
  assert.equal(
    runtime.snapshot().conversations.find((c) => c.id === overridden.id).model,
    'model-a',
  );
  assert.equal(adapter.discoverCalls, 0);
  assert.equal(runtime.snapshot().runs.length, 0);
  await runtime.send({ conversationId: inherited.id, text: 'Inherit defaults.' });
  await waitFor(() => !runtime.hasActiveWork());
  await runtime.send({ conversationId: overridden.id, text: 'Use override.' });
  await waitFor(() => !runtime.hasActiveWork());
  await runtime.setConversationSelection({ conversationId: overridden.id, selection: null });
  await runtime.send({ conversationId: overridden.id, text: 'Back to defaults.' });
  await waitFor(() => !runtime.hasActiveWork());
  assert.deepEqual(
    runtime.snapshot().runs.map((run) => [run.model, run.effort, run.settingsSource]),
    [
      ['model-b', 'high', 'project'],
      ['model-a', 'low', 'conversation'],
      ['model-b', 'high', 'project'],
    ],
  );
  assert.equal(runtime.snapshot().conversations.find((c) => c.id === inherited.id).model, '');
  await runtime.close();
});

test('external defaults affect new runs while active runs and their manifests retain the starting choice', async (t) => {
  const paths = await fixture(t);
  const gate = deferred();
  const runtime = new Runtime(
    new FakeHarnessAdapter({
      run: async (_input, index) => (index === 0 ? gate.promise : { status: 'completed' }),
    }),
    paths.dataRoot,
  );
  const project = runtime.addProject(paths.projectRoot);
  const first = runtime.createConversation(project.id);
  const second = runtime.createConversation(project.id);
  const saved = await runtime.saveProjectDefaults({
    projectId: project.id,
    defaults: { harness: 'codex', model: 'model-a', effort: 'low' },
    expectedRevision: null,
  });
  const run = await runtime.send({ conversationId: first.id, text: 'First choice.' });
  await writeFile(
    join(paths.projectRoot, 'config.harness.yaml'),
    'schemaVersion: 1\nharness: codex\nmodel: model-b\neffort: high\n',
  );
  await assert.rejects(
    runtime.saveProjectDefaults({
      projectId: project.id,
      defaults: { harness: 'codex', model: 'model-a', effort: 'low' },
      expectedRevision: saved.revision,
    }),
    /changed|stale/i,
  );
  await runtime.send({ conversationId: second.id, text: 'New choice.' });
  const manifest = JSON.parse(
    await readFile(join(runtime.store.runDirectory(run), 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.configuration.model, 'model-a');
  assert.equal(manifest.projectSettingsRevision, saved.revision);
  assert.deepEqual(
    runtime.snapshot().runs.map((r) => [r.model, r.effort]),
    [
      ['model-a', 'low'],
      ['model-b', 'high'],
    ],
  );
  gate.resolve({ status: 'completed' });
  await waitFor(() => !runtime.hasActiveWork());
  await runtime.close();
});

test('invalid project config and unavailable saved models block dispatch without a silent substitution', async (t) => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter();
  const runtime = new Runtime(adapter, paths.dataRoot);
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await writeFile(join(paths.projectRoot, 'config.harness.yaml'), 'schemaVersion: 999\n');
  assert.ok(runtime.snapshot().projects[0].harnessSettings.error);
  await assert.rejects(
    runtime.send({ conversationId: conversation.id, text: 'Invalid settings.' }),
    /config|settings|version/i,
  );
  await writeFile(
    join(paths.projectRoot, 'config.harness.yaml'),
    'schemaVersion: 1\nharness: codex\nmodel: unavailable-model\neffort: low\n',
  );
  await assert.rejects(
    runtime.send({ conversationId: conversation.id, text: 'Unavailable choice.' }),
    /available model/i,
  );
  await assert.rejects(
    runtime.setConversationSelection({
      conversationId: conversation.id,
      selection: { harness: 'codex', model: 'model-a', effort: 'high' },
    }),
    /available model/i,
  );
  assert.equal(adapter.runCalls.length, 0);
  assert.equal(runtime.snapshot().runs.length, 0);
  await runtime.close();
});

test('project executable choice binds new runs and later setting changes cannot redirect their checks', async (t) => {
  const { projectRoot, dataRoot } = await fixture(t);
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo ok' } }),
  );
  git(projectRoot, ['add', 'package.json']);
  git(projectRoot, ['commit', '-m', 'checks']);
  const inputs = [],
    commands = [];
  const adapter = {
    async installations() {
      return [{ executable: '/cli/one' }, { executable: '/cli/two' }];
    },
    async discover(executable) {
      return {
        ...harnessInfo,
        executable: executable ?? '/cli/default',
        executionModes: ['read-only', 'code'],
      };
    },
    async run(input) {
      inputs.push(input);
      input.onEvent({
        type: 'session.turn-started',
        summary: 'fixture turn established',
        data: {
          threadId: 'executable-choice-thread',
          turnId: `executable-choice-turn-${inputs.length}`,
        },
      });
      await writeFile(join(input.workspace, 'README.md'), 'changed');
      return { status: 'completed' };
    },
    async runCommand(input) {
      commands.push(input);
      return { exitCode: 0, output: 'passed', truncated: false, cleanupVerified: true };
    },
  };
  const runtime = new Runtime(adapter, dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(projectRoot);
  const settings = await runtime.saveProjectDefaults({
    projectId: project.id,
    defaults: { harness: 'codex', model: 'model-a', effort: 'low', executable: '/cli/one' },
    expectedRevision: null,
  });
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const run = await runtime.send(sendInput(conversation.id));
  await waitFor(() => runtime.snapshot().runs[0].status === 'completed');
  assert.equal(inputs[0].executable, '/cli/one');
  assert.equal(runtime.snapshot().runs[0].executable, '/cli/one');
  assert.equal(runtime.snapshot().runs[0].executableVersion, 'test-version');
  await runtime.saveProjectDefaults({
    projectId: project.id,
    defaults: { harness: 'codex', model: 'model-a', effort: 'low', executable: '/cli/two' },
    expectedRevision: settings.revision,
  });
  const review = runtime.prepareReview(conversation.id);
  await runtime.verifyReview(review.id);
  assert.ok(commands.length > 0);
  assert.ok(
    commands.every(
      (command) =>
        command.executable === '/cli/one' && command.executableVersion === 'test-version',
    ),
  );
  assert.equal(run.executable, '/cli/one');
  assert.equal((await runtime.harness(project.id)).executable, '/cli/two');
});

test('catalog-only discovery is cancellable background work without an active-run quit confirmation', async (t) => {
  const paths = await fixture(t);
  const adapter = new FakeHarnessAdapter({
    discover: async (_, signal) => {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      return { ...harnessInfo, available: false, authenticated: false };
    },
  });
  const runtime = new Runtime(adapter, paths.dataRoot);
  const pending = runtime.harness();
  const rejected = assert.rejects(pending, /cancelled/);
  await waitFor(() => adapter.discoverCalls === 1);
  assert.equal(runtime.hasActiveWork(), true);
  assert.equal(runtime.hasActiveWork({ includeDiscovery: false }), false);
  await runtime.close();
  await rejected;
});
