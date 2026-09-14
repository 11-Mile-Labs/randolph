import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeAdmission } from '../dist/native-admission.js';
import { Store } from '../dist/store.js';

const input = () => ({ messages: [], signal: new AbortController().signal });

async function waitFor(predicate, message) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t, limits = { app: 4, perHarness: 1 }) {
  const root = mkdtempSync(join(tmpdir(), 'randolph-native-stop-run-')),
    store = new Store(root);
  const createdAt = new Date().toISOString();
  store.putProject({ id: 'project', root: '/fixture', name: 'fixture', createdAt });
  for (const id of ['target', 'other']) {
    store.putConversation({
      id: `conversation-${id}`,
      projectId: 'project',
      title: id,
      model: 'fixture',
      effort: 'low',
      createdAt,
      updatedAt: createdAt,
      lastReadSequence: 0,
    });
    store.putRun({
      id,
      projectId: 'project',
      conversationId: `conversation-${id}`,
      status: 'completed',
      model: 'fixture',
      effort: 'low',
      workspace: '/fixture',
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
    });
  }
  const service = new NativeAdmission(store, { fixture: true }, limits);
  const beforeClose = new Set();
  t.after(async () => {
    for (const release of beforeClose) release();
    await service.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { service, onClose: (release) => beforeClose.add(release) };
}

function context(runId) {
  return { owner: { kind: 'run', id: runId }, runId };
}

test('stopRun cancels only matching active and queued operations while unrelated runs remain active and queued', async (t) => {
  const { service, onClose } = fixture(t);
  let targetCalls = 0,
    otherCalls = 0;
  const otherGate = deferred();
  onClose(() => otherGate.resolve());
  const target = service.adapter(
    'codex',
    {
      run: async (nativeInput) => {
        targetCalls += 1;
        await new Promise((resolve) => {
          if (nativeInput.signal.aborted) resolve();
          else nativeInput.signal.addEventListener('abort', resolve, { once: true });
        });
        return { status: 'stop-unconfirmed' };
      },
    },
    context('target'),
  );
  const other = service.adapter(
    'grok',
    {
      run: async () => {
        otherCalls += 1;
        if (otherCalls === 1) await otherGate.promise;
        return { status: 'completed' };
      },
    },
    context('other'),
  );
  const targetActive = target.run(input());
  const targetQueued = target.run(input());
  const otherActive = other.run(input());
  const otherQueued = other.run(input());
  const targetQueuedRejected = assert.rejects(targetQueued, /cancelled/i);
  await waitFor(
    () => targetCalls === 1 && otherCalls === 1,
    'matching active operations did not dispatch',
  );
  await service.stopRun('target');
  await targetQueuedRejected;
  const afterStop = service.records.list();
  assert.equal(
    afterStop.filter(
      (operation) => operation.runId === 'target' && operation.state === 'quarantined',
    ).length,
    1,
  );
  assert.equal(
    afterStop.filter(
      (operation) => operation.runId === 'target' && operation.state === 'interrupted',
    ).length,
    1,
  );
  assert.equal(otherCalls, 1);
  assert.equal(
    service.records
      .list()
      .filter((operation) => operation.runId === 'other' && operation.state === 'admitted').length,
    1,
  );
  otherGate.resolve();
  await otherActive;
  await otherQueued;
  assert.equal(otherCalls, 2);
  const later = await other.run(input());
  assert.equal(later.status, 'completed');
  assert.equal(service.hasActiveWork(), false);
  assert.equal((await targetActive).status, 'stop-unconfirmed');
});

test('stopRun sees an operation registered synchronously before its first admission await', async (t) => {
  const { service } = fixture(t);
  let rawCalls = 0;
  const adapter = service.adapter(
    'codex',
    {
      run: async () => {
        rawCalls += 1;
        return { status: 'completed' };
      },
    },
    context('target'),
  );
  const work = adapter.run(input());
  await service.stopRun('target');
  await assert.rejects(work, /cancelled/i);
  assert.equal(rawCalls, 0);
  const operation = service.records.list().find((item) => item.runId === 'target');
  assert.equal(operation?.state, 'interrupted');
  assert.equal(operation?.cleanupConfirmed, true);
  assert.equal(service.hasActiveWork(), false);
});

test('stopRun awaits a queued callback cancellation without invoking the target while another run occupies capacity', async (t) => {
  const { service, onClose } = fixture(t, { app: 1, perHarness: 1 });
  const otherGate = deferred();
  onClose(() => otherGate.resolve());
  let otherCalls = 0,
    targetCalls = 0,
    stop;
  const other = service.adapter(
    'grok',
    {
      run: async () => {
        otherCalls += 1;
        await otherGate.promise;
        return { status: 'completed' };
      },
    },
    context('other'),
  );
  const target = service.adapter(
    'codex',
    {
      run: async () => {
        targetCalls += 1;
        return { status: 'completed' };
      },
    },
    {
      ...context('target'),
      queued: () => {
        stop ??= service.stopRun('target');
      },
    },
  );
  const otherWork = other.run(input());
  await waitFor(() => otherCalls === 1, 'unrelated operation did not occupy capacity');
  const targetWork = target.run(input());
  const targetRejected = assert.rejects(targetWork, /cancelled/i);
  await waitFor(() => stop !== undefined, 'target queue callback did not request cancellation');
  await stop;
  await targetRejected;
  assert.equal(targetCalls, 0);
  const targetOperation = service.records.list().find((operation) => operation.runId === 'target');
  assert.equal(targetOperation?.state, 'interrupted');
  assert.equal(targetOperation?.cleanupConfirmed, true);
  assert.equal(
    service.records.list().find((operation) => operation.runId === 'other')?.state,
    'admitted',
  );
  otherGate.resolve();
  await otherWork;
});
