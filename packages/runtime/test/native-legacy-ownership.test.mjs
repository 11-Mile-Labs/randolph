import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeOperationRecords } from '../dist/native-operation-records.js';
import { reconstructLegacyNativeOwnership } from '../dist/native-legacy-ownership.js';
import { Store } from '../dist/store.js';

function fixture(t, harness = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'randolph-legacy-native-')), store = new Store(root), project = { id: 'project', root: '/fixture', name: 'fixture', createdAt: '2026-01-01T00:00:00.000Z' }, conversation = { id: 'conversation', projectId: project.id, title: 'fixture', model: 'm', effort: 'low', createdAt: project.createdAt, updatedAt: project.createdAt, lastReadSequence: 0 }, run = { id: 'run', projectId: project.id, conversationId: conversation.id, status: 'running', harness, model: 'm', effort: 'low', workspace: '/fixture/workspace', createdAt: project.createdAt, updatedAt: project.createdAt, lastActivityAt: project.createdAt };
  store.putProject(project); store.putConversation(conversation); store.putRun(run); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return { store, run };
}
function session(run, id, state = 'running', cleanupConfirmed) { return { id, runId: run.id, role: 'worker', harness: 'codex', executable: '/fixture/codex', executableVersion: '1', model: 'm', effort: 'low', allowedTools: [], state, createdAt: run.createdAt, updatedAt: run.createdAt, ...(cleanupConfirmed === undefined ? {} : { cleanupConfirmed }) }; }
function insertSession(store, value) { store.db.prepare('INSERT INTO delegation_sessions(id, run_id, task_id, document) VALUES (?, ?, NULL, ?)').run(value.id, value.runId, JSON.stringify(value)); }

test('uses stable session leases, avoids aggregate double-counting, and excludes known cleanup', t => {
  const f = fixture(t); insertSession(f.store, session(f.run, 'one')); insertSession(f.store, session(f.run, 'two')); insertSession(f.store, session(f.run, 'done', 'completed', true));
  assert.deepEqual(reconstructLegacyNativeOwnership(f.store).map(item => item.reservationId), ['legacy:session:one', 'legacy:session:two']);
});

test('deduplicates legacy session ownership represented by schema5 operation records', t => {
  const f = fixture(t); insertSession(f.store, session(f.run, 'one'));
  new NativeOperationRecords(f.store).create({ id: 'op', owner: { kind: 'delegation', id: 'one' }, runId: f.run.id, sessionId: 'one', harness: 'codex', purpose: 'model-turn', capacity: { role: 'worker', authorizationId: 'auth', workerParallelLimit: 1 }, generation: 1, origin: {} });
  assert.deepEqual(reconstructLegacyNativeOwnership(f.store), []);
});

test('keeps setup aggregate ownership available for explicit later reconciliation and rejects unknown harnesses', t => {
  const setup = fixture(t); setup.run.status = 'interrupted'; setup.run.executionMode = 'read-only'; setup.store.putRun(setup.run);
  assert.deepEqual(reconstructLegacyNativeOwnership(setup.store).map(item => item.reservationId), ['legacy:run:run']);
  const bad = fixture(t, 'unknown'); assert.throws(() => reconstructLegacyNativeOwnership(bad.store), /unknown harness/i);
});

test('does not occupy prepared or known-clean interrupted legacy sessions and never invents worker authorization', t => {
  const f = fixture(t); insertSession(f.store, session(f.run, 'prepared', 'prepared')); insertSession(f.store, session(f.run, 'clean', 'interrupted', true));
  assert.deepEqual(reconstructLegacyNativeOwnership(f.store), []);
  insertSession(f.store, session(f.run, 'running', 'running'));
  const [lease] = reconstructLegacyNativeOwnership(f.store);
  assert.equal(lease.role, 'main'); assert.equal(lease.authorizationId, undefined);
});

test('settled native operation suppresses stale legacy session and review checks use owning run harness', t => {
  const f = fixture(t, 'grok'); insertSession(f.store, session(f.run, 'stale'));
  const operations = new NativeOperationRecords(f.store); operations.create({ id: 'settled', owner: { kind: 'delegation', id: 'stale' }, runId: f.run.id, sessionId: 'stale', harness: 'codex', purpose: 'model-turn', capacity: { role: 'main' }, generation: 1, origin: {} }); operations.admit({ id: 'settled', expectedGeneration: 1 }); operations.settle({ id: 'settled', expectedGeneration: 1, status: 'completed', cleanupConfirmed: true, cleanupEvidence: { gone: true } });
  const review = { id: 'review', projectId: 'project', conversationId: 'conversation', runId: f.run.id, createdAt: f.run.createdAt, updatedAt: f.run.createdAt, status: 'checking', basis: {}, verification: { checks: [{ command: { id: 'check' }, cleanupVerified: false }] } }; f.store.putReview(review);
  const leases = reconstructLegacyNativeOwnership(f.store); assert.deepEqual(leases.map(item => item.reservationId), ['legacy:review-check:review:check']); assert.equal(leases[0].harness, 'grok');
});
