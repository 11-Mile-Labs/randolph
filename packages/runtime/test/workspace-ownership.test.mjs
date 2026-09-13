import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
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
