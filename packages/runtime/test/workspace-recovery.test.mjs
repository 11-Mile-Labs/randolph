import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { WorkspaceOwnership } from '../dist/workspace-ownership.js';
import { reconstructLegacyWorkspaceOwnership } from '../dist/workspace-recovery.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-workspace-recovery-'))), store = new Store(join(root, 'data'));
  const project = { id: 'project', root: join(root, 'project') }, conversation = { id: 'conversation', projectId: project.id, title: 'Fixture', model: 'fixture', effort: 'low', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' };
  mkdirSync(project.root); store.putProject(project); store.putConversation(conversation);
  const run = { id: 'run', projectId: project.id, conversationId: conversation.id, harness: 'codex', executable: '/fixture', executableVersion: 'v1', model: 'fixture', effort: 'low', status: 'stop-unconfirmed', cleanupUnconfirmed: true, workspace: join(root, 'missing-workspace'), createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, lastActivityAt: conversation.updatedAt };
  store.putRun(run); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, run, ownership: new WorkspaceOwnership(store) };
}

test('imports deterministic missing-path main, review delivery, integration, and unknown push witnesses without filesystem probes', t => {
  const f = fixture(t);
  const review = { id: 'review', projectId: 'project', conversationId: 'conversation', runId: 'run', createdAt: f.run.createdAt, updatedAt: f.run.updatedAt, status: 'delivering', basis: { root: join(f.root, 'missing-parent'), workspace: f.run.workspace, evidenceDir: join(f.root, 'evidence'), treeOid: 'tree', parentOid: 'parent', parentBranch: 'main', workspaceHead: 'head', files: [], diff: '' }, verification: { checks: [{ cleanupVerified: false }] }, originOperation: 'cleanup-unconfirmed', push: { revision: 'x', plan: {}, status: 'uncertain', result: { cleanupVerified: false } } };
  f.store.putReview(review); f.store.putRun({ ...f.run, integration: { status: 'applying', plan: { basis: { root: join(f.root, 'integration-parent') } } } });
  reconstructLegacyWorkspaceOwnership(f.store, f.ownership);
  const retained = f.ownership.snapshot();
  assert.ok(retained.some(item => item.provenance?.kind === 'run' && item.workspace === f.run.workspace));
  assert.ok(retained.some(item => item.provenance?.kind === 'delivery' && item.workspace === review.basis.root));
  assert.ok(retained.some(item => item.provenance?.kind === 'push' && item.workspace === review.basis.root));
  assert.ok(retained.some(item => item.provenance?.kind === 'integration' && item.workspace === join(f.root, 'integration-parent')));
  assert.ok(retained.some(item => item.provenance?.kind === 'verification' && item.workspace === review.basis.workspace));
  assert.ok(retained.every(item => item.state === 'cleanup-unconfirmed'));
});

test('an exact existing receipt suppresses only its original witness and repeated recovery preserves originals', t => {
  const f = fixture(t);
  f.ownership.retainUncertain({ reservationId: 'exact', ownerId: 'prior', runId: f.run.id, workspace: f.run.workspace, provenance: { kind: 'run', id: f.run.id, projectId: f.run.projectId, conversationId: f.run.conversationId }, cleanupEvidence: { reconciliation: 'legacy-run', fixture: 'prior' } });
  reconstructLegacyWorkspaceOwnership(f.store, f.ownership);
  assert.equal(f.ownership.snapshot().length, 1);
  f.ownership.release({ reservationId: 'exact', generation: 1, cleanupConfirmed: true, cleanupEvidence: { fixture: 'known-clean' } });
  reconstructLegacyWorkspaceOwnership(f.store, f.ownership);
  assert.equal(f.ownership.snapshot().length, 0);
  f.store.putRun({ ...f.run, workspace: join(f.root, 'different-missing-workspace') });
  reconstructLegacyWorkspaceOwnership(f.store, f.ownership);
  assert.equal(f.ownership.snapshot().length, 1);
  reconstructLegacyWorkspaceOwnership(f.store, f.ownership);
  assert.equal(f.ownership.snapshot().length, 1);
});

test('imports a retained ordinary dispatching attempt before task reconciliation can mark recovery', t => {
  const f = fixture(t), workspace = join(f.root, 'attempt-workspace');
  const task = { id: 'task', runId: f.run.id, authorizationId: 'legacy-auth', assignmentId: 'worker', dependencies: [], workspaceIdentity: '', contextArtifacts: [], state: 'running', attempts: [{ id: 'attempt', generation: 1, status: 'dispatching', createdAt: f.run.createdAt, updatedAt: f.run.updatedAt, workspace: { path: workspace, identity: { device: 1, inode: 1 } } }], createdAt: f.run.createdAt, updatedAt: f.run.updatedAt };
  f.store.db.exec('PRAGMA foreign_keys = OFF');
  f.store.db.prepare('INSERT INTO delegation_tasks(id, run_id, authorization_id, document) VALUES (?, ?, ?, ?)').run(task.id, f.run.id, task.authorizationId, JSON.stringify(task));
  f.store.db.exec('PRAGMA foreign_keys = ON');
  reconstructLegacyWorkspaceOwnership(f.store, f.ownership);
  assert.ok(f.ownership.snapshot().some(item => item.provenance?.kind === 'delegation-preparation' && item.provenance.id === 'attempt' && item.workspace === workspace));
});


test('imports a retained pushing record before the Pushes constructor can quarantine it', t => {
  const f = fixture(t);
  const review = { id: 'pushing-review', projectId: f.run.projectId, conversationId: f.run.conversationId, runId: f.run.id, createdAt: f.run.createdAt, updatedAt: f.run.updatedAt, status: 'delivered', merged: true, cleaned: true, basis: { root: join(f.root, 'pushing-parent'), workspace: f.run.workspace, evidenceDir: join(f.root, 'evidence'), treeOid: 'tree', parentOid: 'parent', parentBranch: 'main', workspaceHead: 'head', files: [], diff: '' }, push: { revision: 'pending', plan: {}, status: 'pushing' } };
  f.store.putReview(review);
  reconstructLegacyWorkspaceOwnership(f.store, f.ownership);
  assert.ok(f.ownership.snapshot().some(item => item.provenance?.kind === 'push' && item.provenance.id === review.id && item.workspace === review.basis.root));
});
