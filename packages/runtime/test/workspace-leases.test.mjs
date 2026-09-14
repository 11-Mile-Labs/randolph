import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceLeases } from '../dist/workspace-leases.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-workspace-leases-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('reserves an app-owned planned workspace before creation, binds its actual identity, and replays exactly', (t) => {
  const root = fixture(t),
    workspace = join(root, 'planned-workspace'),
    leases = new WorkspaceLeases();
  const first = leases.acquire({ reservationId: 'reservation-one', runId: 'run-one', workspace });
  assert.equal(first.status, 'acquired');
  assert.equal(first.replayed, false);
  assert.equal(first.lease.identity, undefined);
  const replay = leases.acquire({ reservationId: 'reservation-one', runId: 'run-one', workspace });
  assert.equal(replay.status, 'acquired');
  assert.equal(replay.replayed, true);
  mkdirSync(workspace);
  const bound = leases.bind({
    reservationId: 'reservation-one',
    generation: first.lease.generation,
    workspace,
  });
  assert.equal(bound.workspace, workspace);
  assert.equal(typeof bound.identity?.device, 'number');
  assert.deepEqual(
    leases.release({
      reservationId: 'reservation-one',
      generation: bound.generation,
      cleanupConfirmed: true,
      cleanupEvidence: { removed: true },
    }).status,
    'released',
  );
  assert.throws(
    () =>
      leases.release({
        reservationId: 'reservation-one',
        generation: bound.generation,
        cleanupConfirmed: true,
        cleanupEvidence: { removed: true },
      }),
    /stale/i,
  );
});

test('blocks path and inode aliases, symlink redirection, and replacement replay', (t) => {
  const root = fixture(t),
    leases = new WorkspaceLeases(),
    original = join(root, 'original'),
    renamed = join(root, 'renamed'),
    replacement = join(root, 'replacement');
  mkdirSync(original);
  const owned = leases.acquire({ reservationId: 'owner', runId: 'run-one', workspace: original });
  assert.equal(owned.status, 'acquired');
  renameSync(original, renamed);
  assert.deepEqual(
    leases.acquire({ reservationId: 'rename-alias', runId: 'run-two', workspace: renamed }),
    {
      status: 'blocked',
      reason: { kind: 'workspace-lease', workspace: renamed, reservationId: 'owner' },
    },
  );
  const direct = join(root, 'direct'),
    alias = join(root, 'alias');
  mkdirSync(direct);
  symlinkSync(direct, alias);
  assert.throws(
    () => leases.acquire({ reservationId: 'symlink', runId: 'run-three', workspace: alias }),
    /redirected|canonical/i,
  );
  mkdirSync(replacement);
  const replaced = leases.acquire({
    reservationId: 'replacement',
    runId: 'run-one',
    workspace: replacement,
  });
  assert.equal(replaced.status, 'acquired');
  rmSync(replacement, { recursive: true });
  mkdirSync(replacement);
  assert.throws(
    () =>
      leases.acquire({ reservationId: 'replacement', runId: 'run-one', workspace: replacement }),
    /different identity/i,
  );
});

test('quarantines uncertain cleanup through restart even when its original workspace no longer exists', (t) => {
  const root = fixture(t),
    workspace = join(root, 'quarantined'),
    initial = new WorkspaceLeases();
  mkdirSync(workspace);
  const acquired = initial.acquire({ reservationId: 'quarantine', runId: 'run-one', workspace });
  assert.equal(acquired.status, 'acquired');
  const uncertain = initial.release({
    reservationId: 'quarantine',
    generation: acquired.lease.generation,
    cleanupConfirmed: false,
    cleanupEvidence: { process: 'unknown' },
  });
  assert.equal(uncertain.status, 'cleanup-unconfirmed');
  const persisted = initial.snapshot();
  rmSync(workspace, { recursive: true });
  const restored = new WorkspaceLeases(persisted);
  assert.deepEqual(restored.snapshot(), persisted);
  assert.deepEqual(restored.acquire({ reservationId: 'new-owner', runId: 'run-two', workspace }), {
    status: 'blocked',
    reason: { kind: 'cleanup-unconfirmed', workspace, reservationId: 'quarantine' },
  });
  assert.throws(
    () =>
      restored.release({
        reservationId: 'quarantine',
        generation: acquired.lease.generation - 1,
        cleanupConfirmed: true,
        cleanupEvidence: { reconciled: true },
      }),
    /stale/i,
  );
  assert.equal(
    restored.release({
      reservationId: 'quarantine',
      generation: acquired.lease.generation,
      cleanupConfirmed: true,
      cleanupEvidence: { reconciled: true },
    }).status,
    'released',
  );
});

test('fails closed when the planned path parent cannot be observed', (t) => {
  const root = fixture(t),
    leases = new WorkspaceLeases();
  assert.throws(
    () =>
      leases.acquire({
        reservationId: 'unknown',
        runId: 'run',
        workspace: join(root, 'missing', 'workspace'),
      }),
    /parent cannot be observed/i,
  );
});
