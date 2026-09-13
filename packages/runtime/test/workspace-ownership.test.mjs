import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../dist/store.js';
import { WorkspaceOwnership } from '../dist/workspace-ownership.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-ownership-'))), store = new Store(join(root, 'data'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, ownership: new WorkspaceOwnership(store), request: { reservationId: 'one', ownerId: 'owner', workspace: join(root, 'workspace') } };
}
const release = { reservationId: 'one', generation: 1, cleanupConfirmed: true, cleanupEvidence: { runtimeStageReturned: true } };

test('planned owner exists before creation, binds observed identity, and preserves terminal evidence without a fabricated run', t => {
  const { store, ownership, request } = fixture(t);
  const acquired = ownership.acquire(request); assert.equal(acquired.status, 'acquired'); assert.equal(acquired.lease.runId, undefined); assert.equal(acquired.lease.identity, undefined);
  assert.equal(store.runs().length, 0); assert.equal(store.db.prepare('SELECT run_id FROM workspace_ownership').get().run_id, null);
  mkdirSync(request.workspace); const bound = ownership.bind({ ...release, workspace: request.workspace }); assert.ok(bound.identity.inode);
  assert.equal(ownership.acquire(request).replayed, true);
  assert.equal(ownership.release(release).status, 'released'); assert.equal(ownership.snapshot().length, 0);
  assert.throws(() => ownership.acquire(request), /Terminal/); assert.throws(() => ownership.release(release), /stale/);
  const retained = JSON.parse(store.db.prepare('SELECT document FROM workspace_ownership').get().document);
  assert.equal(retained.state, 'released'); assert.deepEqual(retained.cleanupEvidence, release.cleanupEvidence);
  assert.equal(ownership.acquire({ ...request, reservationId: 'new', ownerId: 'new-owner' }).status, 'acquired');
  assert.throws(() => ownership.release(release), /stale/); assert.equal(ownership.snapshot()[0].ownerId, 'new-owner');
});

test('independent instances and atomic batches never acquire a second writer or leave a partial batch', t => {
  const { root, store, ownership, request } = fixture(t), right = new WorkspaceOwnership(store);
  ownership.acquire(request);
  assert.equal(right.acquire({ ...request, reservationId: 'two', ownerId: 'second' }).status, 'blocked');
  assert.throws(() => right.acquireMany([{ ...request, reservationId: 'three', workspace: join(root, 'other') }, { ...request, reservationId: 'four' }]), /could not acquire/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM workspace_ownership').get().n, 1);
  ownership.release(release);
  assert.equal(right.acquireMany([{ ...request, reservationId: 'three', workspace: join(root, 'other') }, { ...request, reservationId: 'four' }]).length, 2);
});

test('failed persistence rolls back acquisition, binding, quarantine, and release for every instance', t => {
  const { store, ownership, request } = fixture(t), right = new WorkspaceOwnership(store);
  store.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON workspace_ownership BEGIN SELECT RAISE(ABORT, 'ownership write fault'); END");
  assert.throws(() => ownership.acquire(request), /ownership write fault/); assert.equal(right.snapshot().length, 0);
  store.db.exec('DROP TRIGGER fail_insert'); ownership.acquire(request); mkdirSync(request.workspace);
  store.db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON workspace_ownership BEGIN SELECT RAISE(ABORT, 'ownership write fault'); END");
  assert.throws(() => ownership.bind({ ...release, workspace: request.workspace }), /ownership write fault/); assert.equal(right.snapshot()[0].identity, undefined);
  assert.throws(() => ownership.release(release), /ownership write fault/); assert.equal(right.snapshot()[0].state, 'active');
  assert.throws(() => ownership.reconcileOnReopen(), /ownership write fault/); assert.equal(right.snapshot()[0].state, 'active');
  store.db.exec('DROP TRIGGER fail_update'); ownership.bind({ ...release, workspace: request.workspace }); ownership.release(release); assert.equal(right.snapshot().length, 0);
});

test('reopen quarantines runtime-only ownership despite known native cleanup and missing or replaced paths', t => {
  const { root, store, ownership, request } = fixture(t);
  const parent = join(root, 'parent'); mkdirSync(parent); request.workspace = join(parent, 'workspace'); mkdirSync(request.workspace);
  const original = ownership.acquire(request).lease; assert.ok(original.identity.inode);
  ownership.release({ ...release, cleanupConfirmed: false, cleanupEvidence: { nativeCleanupConfirmed: true, runtimeCleanupConfirmed: false } });
  rmSync(parent, { recursive: true });
  const reopened = new WorkspaceOwnership(store); assert.deepEqual(reopened.reconcileOnReopen(), []);
  assert.equal(reopened.acquire(request).status, 'blocked');
  assert.equal(reopened.acquire({ ...request, reservationId: 'replacement' }).status, 'blocked');
  mkdirSync(parent); mkdirSync(request.workspace);
  assert.equal(reopened.acquire({ ...request, reservationId: 'replacement' }).status, 'blocked');
  assert.deepEqual(reopened.snapshot()[0].identity, original.identity);
  const missing = { reservationId: 'preparation', ownerId: 'prep', workspace: join(root, 'never-created') };
  reopened.acquire(missing); const again = new WorkspaceOwnership(store); assert.equal(again.snapshot().find(item => item.reservationId === 'preparation').state, 'active');
  assert.equal(again.reconcileOnReopen()[0].state, 'cleanup-unconfirmed');
  assert.equal(new WorkspaceOwnership(store).reconcileOnReopen().length, 0); assert.equal(again.acquire(missing).status, 'blocked');
});

test('canonical paths, observed identity, symlinks, stale generations, and cleanup evidence fail closed', t => {
  const { root, ownership, request } = fixture(t);
  assert.throws(() => ownership.acquire({ ...request, workspace: 'relative' }), /canonical/);
  const target = join(root, 'target'); mkdirSync(target); symlinkSync(target, request.workspace);
  assert.throws(() => ownership.acquire(request), /redirected|directory/); rmSync(request.workspace); mkdirSync(request.workspace);
  const original = ownership.acquire(request).lease;
  renameSync(request.workspace, join(root, 'moved')); mkdirSync(request.workspace);
  assert.throws(() => ownership.acquire(request), /identity changed/);
  assert.throws(() => ownership.bind({ ...release, workspace: request.workspace }), /identity changed/);
  assert.deepEqual(ownership.snapshot()[0].identity, original.identity);
  assert.throws(() => ownership.release({ ...release, generation: 2 }), /stale/);
  for (const cleanupEvidence of [undefined, {}, [], 'claimed', { nativeCleanupConfirmed: undefined }, { nested: { cleanup: undefined } }, { elapsed: NaN }, { huge: 'a'.repeat(20_000) }, { cycle: 1n }]) assert.throws(() => ownership.release({ ...release, cleanupEvidence }), /evidence/);
  assert.equal(ownership.snapshot()[0].state, 'active');
});

test('retained inode ownership blocks an alias even after the original directory was renamed', t => {
  const { root, ownership, request } = fixture(t); mkdirSync(request.workspace); ownership.acquire(request);
  const moved = join(root, 'moved'); renameSync(request.workspace, moved);
  assert.equal(ownership.acquire({ reservationId: 'other', ownerId: 'other', workspace: moved }).status, 'blocked');
});

test('corrupt retained ownership is rejected without inspecting the filesystem', t => {
  const { store, ownership, request } = fixture(t); ownership.acquire(request);
  store.db.prepare('UPDATE workspace_ownership SET document=?').run(JSON.stringify({ ...ownership.snapshot()[0], generation: 0 }));
  assert.throws(() => new WorkspaceOwnership(store), /invalid/);
});


test('persisted read ownership without an observed identity is rejected at load', t => {
  const { store, ownership, request } = fixture(t);
  mkdirSync(request.workspace); ownership.acquire({ ...request, access: 'read' });
  const retained = JSON.parse(store.db.prepare('SELECT document FROM workspace_ownership').get().document);
  retained.access = 'read'; delete retained.identity;
  store.db.prepare('UPDATE workspace_ownership SET document=?').run(JSON.stringify(retained));
  assert.throws(() => new WorkspaceOwnership(store), /read workspace ownership lacks an observed identity/i);
});

test('provenance is immutable, facade origin is injected, and staged assertion rejects replacement', t => {
  const { root, store, request } = fixture(t), ownership = new WorkspaceOwnership(store, { boot: 'origin' });
  const acquired = ownership.acquire({ ...request, provenance: { kind: 'integration', id: 'plan', origin: { caller: true } }, phase: 'prepared' });
  assert.equal(acquired.status, 'acquired'); mkdirSync(request.workspace); const bound = ownership.bind({ reservationId: request.reservationId, generation: 1, workspace: request.workspace });
  assert.equal(ownership.stage({ reservationId: request.reservationId, generation: 1, phase: 'applying' }).phase, 'applying'); assert.equal(ownership.assert({ reservationId: request.reservationId, generation: 1, workspace: request.workspace, identity: bound.identity }).reservationId, request.reservationId);
  renameSync(request.workspace, join(root, 'replaced-old')); mkdirSync(request.workspace);
  assert.throws(() => ownership.assert({ reservationId: request.reservationId, generation: 1, workspace: request.workspace, identity: bound.identity }), /identity changed/);
  const retained = JSON.parse(store.db.prepare('SELECT document FROM workspace_ownership').get().document); assert.deepEqual(retained.provenance.origin, { caller: true });
  assert.throws(() => ownership.acquire({ ...request, provenance: { kind: 'integration', id: 'other' } }), /different ownership/);
});

test('uncertain witnesses aggregate only as quarantine and cannot recreate released ownership', t => {
  const { root, ownership } = fixture(t), workspace = join(root, 'legacy-missing');
  const first = ownership.retainUncertain({ reservationId: 'legacy', ownerId: 'run', workspace, cleanupEvidence: { witness: 'run' }, provenance: { kind: 'run', id: 'run' } });
  assert.equal(first.state, 'cleanup-unconfirmed'); assert.equal(ownership.retainUncertain({ reservationId: 'legacy', ownerId: 'run', workspace, cleanupEvidence: { witness: 'other' }, provenance: { kind: 'run', id: 'run' } }).state, 'cleanup-unconfirmed');
  ownership.release({ reservationId: 'legacy', generation: 1, cleanupConfirmed: true, cleanupEvidence: { reconciled: true } });
  assert.throws(() => ownership.retainUncertain({ reservationId: 'legacy', ownerId: 'run', workspace, cleanupEvidence: { witness: 'run' }, provenance: { kind: 'run', id: 'run' } }), /Terminal/);
});


test('distinct quarantine witnesses sharing a path block until every owner is released', t => {
  const { root, ownership } = fixture(t), workspace = join(root, 'legacy-shared');
  const one = ownership.retainUncertain({ reservationId: 'legacy-run', ownerId: 'run', workspace, cleanupEvidence: { witness: 'run' }, provenance: { kind: 'run', id: 'run' } });
  const two = ownership.retainUncertain({ reservationId: 'legacy-review', ownerId: 'review', workspace, cleanupEvidence: { witness: 'review' }, provenance: { kind: 'review', id: 'review' } });
  assert.equal(one.state, 'cleanup-unconfirmed'); assert.equal(two.state, 'cleanup-unconfirmed');
  assert.equal(ownership.acquire({ reservationId: 'new', ownerId: 'new', workspace }).status, 'blocked');
  ownership.release({ reservationId: 'legacy-run', generation: 1, cleanupConfirmed: true, cleanupEvidence: { reconciled: 'run' } });
  assert.equal(ownership.acquire({ reservationId: 'new', ownerId: 'new', workspace }).status, 'blocked');
  ownership.release({ reservationId: 'legacy-review', generation: 1, cleanupConfirmed: true, cleanupEvidence: { reconciled: 'review' } });
  assert.equal(ownership.acquire({ reservationId: 'new', ownerId: 'new', workspace }).status, 'acquired');
});

test('quarantine inode aliases each block admission until every original witness is released', t => {
  const { root, ownership } = fixture(t), workspace = join(root, 'workspace'), alias = join(root, 'alias'); mkdirSync(workspace); symlinkSync(workspace, alias);
  const stat = statSync(workspace), identity = { device: stat.dev, inode: stat.ino };
  const first = ownership.retainUncertain({ reservationId: 'unknown-one', ownerId: 'one', workspace, identity, cleanupEvidence: { unknown: true }, provenance: { kind: 'run', id: 'one' } });
  const second = ownership.retainUncertain({ reservationId: 'unknown-two', ownerId: 'two', workspace: alias, identity, cleanupEvidence: { unknown: true }, provenance: { kind: 'review', id: 'two' } });
  assert.equal(first.state, 'cleanup-unconfirmed'); assert.equal(second.state, 'cleanup-unconfirmed');
  assert.equal(ownership.acquire({ reservationId: 'active', ownerId: 'active', workspace }).status, 'blocked');
  ownership.release({ reservationId: 'unknown-one', generation: 1, cleanupConfirmed: true, cleanupEvidence: { reconciled: 'one' } });
  assert.equal(ownership.acquire({ reservationId: 'active', ownerId: 'active', workspace }).status, 'blocked');
  ownership.release({ reservationId: 'unknown-two', generation: 1, cleanupConfirmed: true, cleanupEvidence: { reconciled: 'two' } });
  assert.equal(ownership.acquire({ reservationId: 'active', ownerId: 'active', workspace }).status, 'acquired');
});

test('active ownership rejects an uncertain witness, while constructor permits only quarantine overlap', t => {
  const { root, store, ownership } = fixture(t), workspace = join(root, 'workspace'); mkdirSync(workspace);
  assert.equal(ownership.acquire({ reservationId: 'active', ownerId: 'active', workspace }).status, 'acquired');
  assert.throws(() => ownership.retainUncertain({ reservationId: 'unknown', ownerId: 'unknown', workspace, cleanupEvidence: { unknown: true }, provenance: { kind: 'run', id: 'unknown' } }), /active ownership/i);
  ownership.release({ reservationId: 'active', generation: 1, cleanupConfirmed: false, cleanupEvidence: { unknown: true } });
  ownership.retainUncertain({ reservationId: 'unknown', ownerId: 'unknown', workspace, cleanupEvidence: { unknown: true }, provenance: { kind: 'run', id: 'unknown' } });
  assert.doesNotThrow(() => new WorkspaceOwnership(store));
  const retained = store.db.prepare('SELECT document FROM workspace_ownership WHERE id=?').get('unknown');
  const active = JSON.parse(retained.document); active.state = 'active'; delete active.cleanupEvidence;
  store.db.prepare('UPDATE workspace_ownership SET document=? WHERE id=?').run(JSON.stringify(active), 'unknown');
  assert.throws(() => new WorkspaceOwnership(store), /conflicts/);
});

test('active readers share one observed workspace while writers and write batches remain exclusive', t => {
  const { store, ownership, request } = fixture(t); mkdirSync(request.workspace);
  const first = ownership.acquire({ ...request, access: 'read' }); assert.equal(first.status, 'acquired');
  const other = new WorkspaceOwnership(store);
  assert.equal(other.acquire({ ...request, reservationId: 'two', ownerId: 'two', access: 'read' }).status, 'acquired');
  assert.equal(other.acquire({ ...request, reservationId: 'writer', ownerId: 'writer', access: 'write' }).status, 'blocked');
  assert.throws(() => other.acquireMany([{ ...request, reservationId: 'third', ownerId: 'third', access: 'read' }, { ...request, reservationId: 'batch-writer', ownerId: 'batch-writer', access: 'write' }]), /could not acquire/);
  assert.equal(ownership.snapshot().length, 2);
});

test('read access is immutable, requires an observed directory, and quarantines all later readers and writers', t => {
  const { root, store, ownership, request } = fixture(t); mkdirSync(request.workspace);
  const reader = ownership.acquire({ ...request, access: 'read' }); assert.equal(reader.status, 'acquired');
  assert.throws(() => ownership.acquire({ ...request, access: 'write' }), /different ownership/);
  assert.throws(() => ownership.acquire({ reservationId: 'missing-read', ownerId: 'reader', workspace: join(root, 'missing'), access: 'read' }), /existing observed/i);
  const sibling = ownership.acquire({ ...request, reservationId: 'sibling', ownerId: 'sibling', access: 'read' }); assert.equal(sibling.status, 'acquired');
  ownership.release({ reservationId: reader.lease.reservationId, generation: reader.lease.generation, cleanupConfirmed: false, cleanupEvidence: { unknown: true } });
  assert.doesNotThrow(() => new WorkspaceOwnership(store));
  assert.throws(() => ownership.assert({ reservationId: sibling.lease.reservationId, generation: sibling.lease.generation, workspace: request.workspace, identity: sibling.lease.identity }), /uncertain cleanup/i);
  assert.equal(ownership.acquire({ ...request, reservationId: 'late-read', ownerId: 'late', access: 'read' }).status, 'blocked');
  assert.equal(ownership.acquire({ ...request, reservationId: 'late-write', ownerId: 'late', access: 'write' }).status, 'blocked');
  const reopened = new WorkspaceOwnership(store); reopened.reconcileOnReopen();
  assert.equal(reopened.snapshot().filter(item => item.state === 'cleanup-unconfirmed').length, 2);
  reopened.release({ reservationId: reader.lease.reservationId, generation: reader.lease.generation, cleanupConfirmed: true, cleanupEvidence: { settled: 'one' } });
  assert.equal(reopened.acquire({ ...request, reservationId: 'still-blocked', ownerId: 'late', access: 'read' }).status, 'blocked');
  reopened.release({ reservationId: sibling.lease.reservationId, generation: sibling.lease.generation, cleanupConfirmed: true, cleanupEvidence: { settled: 'two' } });
  assert.equal(reopened.acquire({ ...request, reservationId: 'fresh-reader', ownerId: 'fresh', access: 'read' }).status, 'acquired');
});

test('reader identity aliases are compatible only with readers and retained read uncertainty preserves identity', t => {
  const { root, ownership } = fixture(t); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const identity = { device: statSync(workspace).dev, inode: statSync(workspace).ino };
  ownership.retainUncertain({ reservationId: 'reader-unknown', ownerId: 'reader', workspace, identity, access: 'read', cleanupEvidence: { unknown: true } });
  assert.throws(() => ownership.retainUncertain({ reservationId: 'missing-reader', ownerId: 'reader', workspace: join(root, 'missing'), access: 'read', cleanupEvidence: { unknown: true } }), /identity/i);
  assert.equal(ownership.acquire({ reservationId: 'writer', ownerId: 'writer', workspace, access: 'write' }).status, 'blocked');
});
