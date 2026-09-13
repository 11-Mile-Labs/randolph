import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { DelegationRecords } from '../dist/delegation-records.js';
import { defaultDelegationLimits } from '../dist/delegation-plan.js';

const assignment = (id, role, source, dependencies, extra = {}) => ({ id, task: `${id} task`, role, harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', rationale: `${id} rationale`, dependencies, source, mode: role === 'review' || role === 'main-synthesis' ? 'read-only' : 'code', deliverables: [`${id} output`], completionCriteria: [`${id} complete`], ...extra });
const plan = revision => ({ schemaVersion: 1, id: 'delegation-plan', revision, limits: { ...defaultDelegationLimits }, assignments: [
  assignment('writer', 'worker', 'run-basis', [], { producesSource: true }),
  assignment('integrate', 'main-integration', 'output:writer', ['writer'], { producesSource: true, integrationInputs: ['writer'] }),
  assignment('verify', 'runtime-verification', 'output:integrate', ['integrate'], { producesSource: true }),
  assignment('synthesize', 'main-synthesis', 'output:verify', ['verify']),
] });
function addRun(store, id, projectId = 'project', conversationId = 'conversation') {
  store.putProject({ id: projectId, root: `/tmp/${projectId}`, createdAt: '2026-09-12T00:00:00.000Z' });
  store.putConversation({ id: conversationId, projectId, title: 'Delegation', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' });
  store.putRun({ id, projectId, conversationId, status: 'running', model: 'model', effort: 'low', workspace: `/tmp/${id}`, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', lastActivityAt: '2026-09-12T00:00:00.000Z' });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-delegation-records-')); const store = new Store(root); addRun(store, 'run-one');
  t.after(async () => { try { store.close(); } catch { /* Reopen persistence tests may already close it. */ } await rm(root, { recursive: true, force: true }); });
  return { root, store, records: new DelegationRecords(store) };
}
function draft(records, revision = 1) { return records.recordPlan({ runId: 'run-one', revision, requestId: `request-${revision}`, source: 'proposal', basis: { runBasis: `basis-${revision}` }, plan: plan(revision) }); }
function ready(records, revision = 1) { const value = draft(records, revision); return records.readyPlan({ runId: value.runId, planId: value.id, digest: value.digest, basisDigest: value.basisDigest }); }
function authorize(records, value) { return records.authorize({ runId: 'run-one', planId: value.id, digest: value.digest, basisDigest: value.basisDigest, decision: 'user', presetSaved: false }); }

test('migration upgrades v2 data additively and keeps the existing records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'randolph-delegation-v2-')); t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const database = new DatabaseSync(join(root, 'app.sqlite'));
  database.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, document TEXT NOT NULL); CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, document TEXT NOT NULL); CREATE TABLE reviews (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, document TEXT NOT NULL); PRAGMA user_version=2;');
  database.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('old-project', '/tmp/old', '{"id":"old-project"}'); database.close();
  const store = new Store(root); assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 5); assert.equal(store.projects()[0].id, 'old-project'); assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_tool_receipts'").get()); store.close();
});

test('only the latest exact ready plan basis can authorize and older revisions remain historical', async t => {
  const { records } = await fixture(t); const first = draft(records); const second = draft(records, 2); const readySecond = records.readyPlan({ runId: second.runId, planId: second.id, digest: second.digest, basisDigest: second.basisDigest });
  assert.equal(records.plans('run-one').find(item => item.id === first.id).disposition, 'superseded');
  assert.throws(() => draft(records, 4), /monotonically/i);
  assert.throws(() => authorize(records, first), /stale|ready/i);
  assert.throws(() => records.authorize({ runId: 'run-one', planId: readySecond.id, digest: readySecond.digest, basisDigest: 'wrong', decision: 'user', presetSaved: false }), /stale|basis/i);
  const authorization = authorize(records, readySecond); assert.equal(authorization.planId, second.id); assert.equal(records.plans('run-one').find(item => item.id === second.id).disposition, 'authorized');
});

test('a graph-invalid draft remains editable but cannot become ready or authorize until corrected', async t => {
  const { records } = await fixture(t); const cyclic = plan(1); cyclic.assignments.find(node => node.id === 'writer').dependencies = ['synthesize']; cyclic.assignments.find(node => node.id === 'synthesize').dependencies = ['verify', 'writer']; const first = records.recordPlan({ runId: 'run-one', revision: 1, requestId: 'request-1', source: 'proposal', basis: { runBasis: 'basis-1' }, plan: cyclic });
  assert.equal(first.disposition, 'draft'); assert.throws(() => records.readyPlan({ runId: 'run-one', planId: first.id, digest: first.digest, basisDigest: first.basisDigest }), /acyclic/i); assert.throws(() => records.authorize({ runId: 'run-one', planId: first.id, digest: first.digest, basisDigest: first.basisDigest, decision: 'user', presetSaved: false }), /ready|stale/i);
  const corrected = records.recordPlan({ runId: 'run-one', revision: 2, requestId: 'request-2', source: 'proposal', basis: { runBasis: 'basis-2' }, plan: plan(2) }); const readyPlan = records.readyPlan({ runId: 'run-one', planId: corrected.id, digest: corrected.digest, basisDigest: corrected.basisDigest }); assert.equal(readyPlan.disposition, 'ready');
});

test('a preset-save receipt is independent of plan authorization', async t => {
  const { records } = await fixture(t); const value = ready(records);
  const saved = records.recordPresetSave({ runId: 'run-one', planId: value.id, presetId: 'daily-code', digest: value.digest, basisDigest: value.basisDigest });
  assert.equal(saved.planId, value.id); assert.equal(records.authorizations('run-one').length, 0); assert.equal(records.plans('run-one')[0].disposition, 'ready');
  assert.throws(() => records.recordPresetSave({ runId: 'run-one', planId: value.id, presetId: 'bad', digest: 'wrong', basisDigest: value.basisDigest }), /match/i);
});

test('tasks and sessions stay scoped to their existing run and retain attempts and cleanup uncertainty', async t => {
  const { store, records } = await fixture(t); addRun(store, 'run-two', 'project-two', 'conversation-two'); const authorization = authorize(records, ready(records));
  const [task] = records.createTasks({ runId: 'run-one', authorizationId: authorization.id });
  assert.equal(records.recordAttempt({ runId: 'run-one', taskId: task.id, attempt: { id: 'attempt-one', generation: 1, status: 'dispatching' } }).attempts.length, 1);
  assert.throws(() => records.recordSession({ id: 'cross-run', runId: 'run-two', taskId: task.id, role: 'worker', harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', allowedTools: [], state: 'prepared' }), /another run|does not exist/i);
  records.recordSession({ id: 'worker-session', runId: 'run-one', taskId: task.id, role: 'worker', harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', allowedTools: [], state: 'prepared' });
  assert.equal(records.reconcileUnfinishedSessions()[0].state, 'cleanup-unconfirmed'); assert.equal(records.sessions('run-one')[0].cleanupConfirmed, false);
});

test('tool receipts require an exact bound main turn, atomically replay, and reject conflicting identities', async t => {
  const { records } = await fixture(t); records.recordSession({ id: 'main-session', runId: 'run-one', role: 'main', harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', allowedTools: ['randolph_propose_delegation'], state: 'prepared' }); records.bindSession({ runId: 'run-one', sessionId: 'main-session', threadId: 'thread', turnId: 'turn' });
  const input = { runId: 'run-one', sessionId: 'main-session', threadId: 'thread', turnId: 'turn', callId: 'call', requestId: 0, tool: 'randolph_propose_delegation', payload: { revision: 1 } }; let mutations = 0;
  const first = records.recordToolReceipt(input, () => { mutations += 1; return { planId: 'plan' }; }); const replay = records.recordToolReceipt(input, () => { mutations += 1; return { planId: 'wrong' }; });
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt.receipt, { planId: 'plan' }); assert.equal(mutations, 1);
  assert.throws(() => records.recordToolReceipt({ ...input, payload: { revision: 2 } }, () => ({ planId: 'other' })), /reused/i);
  assert.throws(() => records.recordToolReceipt({ ...input, callId: 'other-call' }, () => ({ planId: 'other' })), /reused/i);
  assert.throws(() => records.recordToolReceipt({ ...input, turnId: 'forged' }, () => ({ planId: 'other' })), /bound/i);
  assert.throws(() => records.recordToolReceipt({ ...input, callId: 'large-call', requestId: 'large-rpc', payload: { body: 'x'.repeat(65_537) } }, () => ({ planId: 'other' })), /64 KB/i);
  assert.throws(() => records.recordToolReceipt({ ...input, callId: 'failed-call', requestId: 'failed-rpc' }, () => { throw new Error('callback failed'); }), /callback failed/);
  const afterFailure = records.recordToolReceipt({ ...input, callId: 'failed-call', requestId: 'failed-rpc' }, () => ({ planId: 'after-failure' })); assert.equal(afterFailure.replayed, false);
});

test('session binding is idempotent only for its exact turn and terminal state needs cleanup evidence', async t => {
  const { root, store, records } = await fixture(t); records.recordSession({ id: 'worker-session', runId: 'run-one', role: 'worker', harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', allowedTools: [], state: 'dispatch-intent' });
  assert.equal(records.bindSession({ runId: 'run-one', sessionId: 'worker-session', threadId: 'thread', turnId: 'turn' }).state, 'running');
  assert.equal(records.bindSession({ runId: 'run-one', sessionId: 'worker-session', threadId: 'thread', turnId: 'turn' }).state, 'running');
  assert.throws(() => records.bindSession({ runId: 'run-one', sessionId: 'worker-session', threadId: 'thread', turnId: 'other-turn' }), /rebound/i);
  assert.equal(records.finishSession({ runId: 'run-one', sessionId: 'worker-session', status: 'completed', cleanupConfirmed: true, cleanupEvidence: { processExit: 'verified' } }).state, 'completed'); assert.deepEqual(records.sessions('run-one')[0].cleanupEvidence, { processExit: 'verified' }); store.close(); const reopened = new Store(root); assert.deepEqual(new DelegationRecords(reopened).sessions('run-one')[0].cleanupEvidence, { processExit: 'verified' }); reopened.close();
});

test('a pre-bind startup failure can settle only as failed or interrupted with cleanup evidence', async t => {
  const { records } = await fixture(t); records.recordSession({ id: 'startup-session', runId: 'run-one', role: 'worker', harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', allowedTools: [], state: 'prepared' });
  assert.throws(() => records.finishSession({ runId: 'run-one', sessionId: 'startup-session', status: 'completed', cleanupConfirmed: true, cleanupEvidence: { processExit: true } }), /bound active native turn/i);
  const finished = records.finishSession({ runId: 'run-one', sessionId: 'startup-session', status: 'failed', cleanupConfirmed: true, cleanupEvidence: { launch: 'failed-before-thread' }, error: 'launch failed' }); assert.equal(finished.state, 'failed'); assert.deepEqual(finished.cleanupEvidence, { launch: 'failed-before-thread' });
});

test('a deferred foreign-key commit failure leaves transaction depth recoverable', async t => {
  const { store } = await fixture(t); store.db.exec('CREATE TABLE deferred_fk_test (project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);');
  assert.throws(() => store.transaction(() => { store.db.prepare('INSERT INTO deferred_fk_test VALUES (?)').run('missing-project'); }), /FOREIGN KEY/i);
  assert.doesNotThrow(() => store.transaction(() => { store.db.prepare('SELECT 1').get(); }));
});

test('a draft cannot become ready while any native session is unfinished or cleanup-unconfirmed', async t => {
  const { records } = await fixture(t); records.recordSession({ id: 'main-session', runId: 'run-one', role: 'main', harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', allowedTools: ['randolph_read_tasks'], state: 'prepared' }); const value = draft(records);
  assert.throws(() => records.readyPlan({ runId: 'run-one', planId: value.id, digest: value.digest, basisDigest: value.basisDigest }), /cleanup/i);
});

test('nested plan mutation and its tool receipt share one rollback boundary', async t => {
  const { store, records } = await fixture(t); records.recordSession({ id: 'main-session', runId: 'run-one', role: 'main', harness: 'grok', executable: '/opt/grok', executableVersion: '1', model: 'model', effort: 'low', allowedTools: ['randolph_propose_delegation'], state: 'prepared' }); records.bindSession({ runId: 'run-one', sessionId: 'main-session', threadId: 'thread', turnId: 'turn' }); const before = store.events('run-one').length;
  const input = { runId: 'run-one', sessionId: 'main-session', threadId: 'thread', turnId: 'turn', callId: 'call', requestId: 'rpc', tool: 'randolph_propose_delegation', payload: { revision: 1 } };
  assert.throws(() => records.recordToolReceipt(input, () => { records.recordPlan({ runId: 'run-one', revision: 1, requestId: 'request-1', source: 'proposal', basis: { runBasis: 'basis-1' }, plan: plan(1) }); return { invalid: () => {} }; }));
  assert.equal(records.plans('run-one').length, 0); assert.equal(store.events('run-one').length, before);
  const first = records.recordToolReceipt(input, () => ({ planId: records.recordPlan({ runId: 'run-one', revision: 1, requestId: 'request-1', source: 'proposal', basis: { runBasis: 'basis-1' }, plan: plan(1) }).id }));
  const replay = records.recordToolReceipt(input, () => { throw new Error('must not run'); }); assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(records.plans('run-one').length, 1);
});

 test('pre-bind cleanup uncertainty remains quarantined without inventing a native turn', async t => {
  const { records } = await fixture(t);
  records.recordSession({ id: 'uncertain-start', runId: 'run-one', role: 'main', harness: 'codex', executable: '/opt/codex', executableVersion: '1', model: 'model', effort: 'low', allowedTools: [], state: 'dispatch-intent' });
  const session = records.finishSession({ runId: 'run-one', sessionId: 'uncertain-start', status: 'interrupted', cleanupConfirmed: false, error: 'process cleanup unconfirmed before native binding' });
  assert.equal(session.state, 'cleanup-unconfirmed'); assert.equal(session.native, undefined); assert.equal(session.cleanupEvidence, undefined);
});
