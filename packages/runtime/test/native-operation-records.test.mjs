import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeOperationRecords } from '../dist/native-operation-records.js';
import { Store } from '../dist/store.js';
import { DatabaseSync } from 'node:sqlite';

test('persists exact native intent, admission, settlement, and reopen quarantine', t => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-native-operations-')), store = new Store(root), records = new NativeOperationRecords(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const intent = { id: 'operation-one', owner: { kind: 'app-discovery', id: 'codex' }, harness: 'codex', purpose: 'discovery', capacity: { role: 'discovery' }, generation: 1, origin: { fixture: true } };
  assert.equal(records.create(intent).state, 'queued'); assert.equal(records.create(intent).state, 'queued');
  assert.throws(() => records.create({ ...intent, purpose: 'command' }), /different intent/i);
  assert.equal(records.admit({ id: intent.id, expectedGeneration: 1 }).state, 'admitted');
  assert.equal(records.resolveIdentity({ id: intent.id, expectedGeneration: 1, resolvedIdentity: { executable: '/fixture/codex', version: '1' } }).resolvedIdentity.version, '1');
  assert.equal(records.settle({ id: intent.id, expectedGeneration: 1, status: 'completed', cleanupConfirmed: true, cleanupEvidence: { exited: true } }).state, 'settled');
  const pending = records.create({ ...intent, id: 'operation-two', owner: { kind: 'delegation', id: 'task' } }); records.admit({ id: pending.id, expectedGeneration: 1 });
  assert.equal(records.reconcileOnReopen()[0].state, 'quarantined'); assert.equal(records.events(intent.id).map(event => event.type).join(','), 'queued,admitted,resolved,settled');
});

test('upgrades schema4 to schema5 additively and remains idempotent after reopen', t => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-native-migration-')), database = new DatabaseSync(join(root, 'app.sqlite'));
  database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, document TEXT NOT NULL); CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE reviews (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE delegation_controls (run_id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL, document TEXT NOT NULL); PRAGMA user_version=4;"); database.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('old', '/old', JSON.stringify({ id: 'old' })); database.close();
  const first = new Store(root); assert.equal(first.db.prepare('PRAGMA user_version').get().user_version, 5); assert.equal(first.projects()[0].id, 'old'); assert.ok(first.db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_operations'").get()); first.close();
  const reopened = new Store(root); assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 5); assert.equal(reopened.projects()[0].id, 'old'); reopened.close(); t.after(() => rmSync(root, { recursive: true, force: true }));
});

test('settles only a durably later-boot reconciled project-setup model turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-native-setup-')), store = new Store(root), at = '2026-01-01T00:00:00.000Z', project = { id: 'project', root: '/fixture', name: 'fixture', createdAt: at }, conversation = { id: 'conversation', projectId: project.id, kind: 'project-setup', title: 'setup', model: 'm', effort: 'low', createdAt: at, updatedAt: at, lastReadSequence: 0 }, run = { id: 'run', projectId: project.id, conversationId: conversation.id, status: 'interrupted', cleanupUnconfirmed: false, executionMode: 'read-only', model: 'm', effort: 'low', workspace: '/fixture/workspace', createdAt: at, updatedAt: at, lastActivityAt: at }, origin = { boot: 'old' };
  run.executionOrigin = origin;
  store.putProject(project); store.putConversation(conversation); store.putRun(run); store.db.prepare('INSERT INTO delegation_sessions(id, run_id, task_id, document) VALUES (?, ?, NULL, ?)').run('session', run.id, JSON.stringify({ id: 'session', runId: run.id, role: 'main', state: 'interrupted', cleanupConfirmed: true, cleanupEvidence: { reconciliation: 'later-boot' }, origin }));
  const records = new NativeOperationRecords(store), intent = { id: 'setup-op', owner: { kind: 'run', id: run.id }, runId: run.id, sessionId: 'session', harness: 'codex', purpose: 'model-turn', capacity: { role: 'main' }, generation: 1, origin };
  records.create(intent); records.admit({ id: intent.id, expectedGeneration: 1 }); records.settle({ id: intent.id, expectedGeneration: 1, status: 'interrupted', cleanupConfirmed: false });
  const sessionRow = store.db.prepare('SELECT document FROM delegation_sessions WHERE id=?').get('session');
  const savedSession = JSON.parse(sessionRow.document);
  store.db.prepare('UPDATE delegation_sessions SET document=? WHERE id=?').run(JSON.stringify({ ...savedSession, cleanupEvidence: undefined }), 'session');
  assert.throws(() => records.reconcileSetupCleanup(run.id), /proof/); assert.equal(records.list()[0].state, 'quarantined');
  store.db.prepare('UPDATE delegation_sessions SET document=? WHERE id=?').run(sessionRow.document, 'session');
  store.putRun({ ...run, executionMode: 'code' }); assert.throws(() => records.reconcileSetupCleanup(run.id), /read-only/);
  store.putRun(run);
  assert.equal(records.reconcileSetupCleanup(run.id)[0].state, 'settled'); assert.equal(records.reconcileSetupCleanup(run.id).length, 0);
  store.close(); rmSync(root, { recursive: true, force: true });
});

test('canonical replay and failed event persistence preserve exact prior operation state', t => {
  const root = mkdtempSync(join(tmpdir(), 'randolph-native-atomic-')), store = new Store(root), records = new NativeOperationRecords(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const intent = { id: 'atomic', owner: { kind: 'app-discovery', id: 'catalog' }, harness: 'codex', purpose: 'discovery', capacity: { role: 'discovery' }, generation: 1, origin: { a: 1, b: 2 } };
  records.create(intent);
  assert.equal(records.create({ ...intent, origin: { b: 2, a: 1 } }).id, intent.id);
  store.db.exec("CREATE TRIGGER event_fault BEFORE INSERT ON native_operation_events BEGIN SELECT RAISE(ABORT, 'event fault'); END");
  assert.throws(() => records.admit({ id: intent.id, expectedGeneration: 1 }), /event fault/);
  assert.equal(records.list()[0].state, 'queued'); assert.equal(records.events(intent.id).length, 1);
  store.db.exec('DROP TRIGGER event_fault'); records.admit({ id: intent.id, expectedGeneration: 1 });
  store.db.exec("CREATE TRIGGER event_fault BEFORE INSERT ON native_operation_events BEGIN SELECT RAISE(ABORT, 'event fault'); END");
  assert.throws(() => records.settle({ id: intent.id, expectedGeneration: 1, status: 'completed', cleanupConfirmed: true, cleanupEvidence: { exited: true } }), /event fault/);
  assert.equal(records.list()[0].state, 'admitted'); assert.equal(records.events(intent.id).length, 2);
});
