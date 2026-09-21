import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../dist/index.js';

const project = () => ({
  id: randomUUID(),
  name: 'fixture',
  root: '/fixture',
  createdAt: new Date().toISOString(),
});
const conversation = (projectId) => ({
  id: randomUUID(),
  projectId,
  title: 'fixture',
  model: 'model',
  effort: 'low',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastReadSequence: 0,
});
const run = (projectId, conversationId) => ({
  id: randomUUID(),
  projectId,
  conversationId,
  status: 'running',
  model: 'model',
  effort: 'low',
  workspace: '/fixture',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
});

test('chat event reads ignore the workspace event cap and filter by run and cursor', () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-chat-events-'));
  const store = new Store(root);
  try {
    const fixtureProject = project();
    const firstConversation = conversation(fixtureProject.id);
    const secondConversation = conversation(fixtureProject.id);
    const firstRun = run(fixtureProject.id, firstConversation.id);
    const secondRun = run(fixtureProject.id, secondConversation.id);
    store.putProject(fixtureProject);
    store.putConversation(firstConversation);
    store.putConversation(secondConversation);
    store.putRun(firstRun);
    store.putRun(secondRun);
    store.append(firstRun, 'message.delta', 'first', { text: 'first' });
    for (let index = 0; index < 2_100; index += 1)
      store.append(secondRun, 'noise', `noise ${index}`);
    assert.equal(
      store.snapshot().events.some((event) => event.runId === firstRun.id),
      false,
    );
    store.putRun({ ...firstRun, status: 'completed' });
    store.append(firstRun, 'run.completed', 'completed');
    const all = store.chatEvents(firstConversation.id, firstRun.id, 0);
    assert.equal(all.run.id, firstRun.id);
    assert.equal(all.run.status, 'completed');
    assert.deepEqual(
      all.events.map((event) => event.type),
      ['message.delta', 'run.completed'],
    );
    assert.deepEqual(
      store
        .chatEvents(firstConversation.id, firstRun.id, all.events[0].sequence)
        .events.map((event) => event.type),
      ['run.completed'],
    );
    assert.throws(() => store.chatEvents(secondConversation.id, firstRun.id, 0), /does not belong/);
    assert.throws(() => store.chatEvents(firstConversation.id, randomUUID(), 0), /does not exist/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
