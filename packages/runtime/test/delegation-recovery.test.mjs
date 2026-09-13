import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime, Store } from '../dist/index.js';
import { DelegationRecords } from '../dist/delegation-records.js';

test('unfinished delegation sessions quarantine even a completed aggregate run across reopenings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'randolph-delegation-reopen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectId = randomUUID(), conversationId = randomUUID(), runId = randomUUID(), at = new Date().toISOString();
  const store = new Store(root);
  store.putProject({ id: projectId, name: 'Project', root, createdAt: at });
  store.putConversation({ id: conversationId, projectId, title: 'Question', model: 'model', effort: 'low', createdAt: at, updatedAt: at, lastReadSequence: 0 });
  store.putRun({ id: runId, projectId, conversationId, workspace: root, status: 'completed', model: 'model', effort: 'low', createdAt: at, updatedAt: at, lastActivityAt: at });
  new DelegationRecords(store).recordSession({ id: randomUUID(), runId, role: 'main', harness: 'codex', executable: '/opt/codex', executableVersion: '1', model: 'model', effort: 'low', allowedTools: [], state: 'dispatch-intent' });
  store.close();
  let launches = 0;
  const adapter = { discover: async () => { launches += 1; throw new Error('Must not discover'); }, run: async () => { launches += 1; throw new Error('Must not run'); } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const runtime = new Runtime(adapter, root);
    try {
      const run = runtime.store.runs()[0];
      assert.equal(run.status, 'interrupted'); assert.equal(run.cleanupUnconfirmed, true);
      assert.equal(new DelegationRecords(runtime.store).sessions(runId)[0].state, 'cleanup-unconfirmed');
      await assert.rejects(runtime.send({ conversationId, text: 'Continue' }), /already has active work/);
      assert.equal(launches, 0);
    } finally { await runtime.close(); }
  }
});
