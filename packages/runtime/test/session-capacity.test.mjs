import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionCapacity } from '../dist/session-capacity.js';

const reservation = (id, overrides = {}) => ({
  reservationId: id,
  runId: 'run-one',
  harness: 'grok',
  role: 'worker',
  authorizationId: 'authorization-one',
  workerParallelLimit: 2,
  ...overrides,
});
const lease = (result) => {
  assert.equal(result.status, 'acquired');
  return result.lease;
};

test('all native roles consume shared app and per-harness capacity across overlapping runs', () => {
  const capacity = new SessionCapacity({ app: 4, perHarness: 2 });
  lease(capacity.acquire(reservation('worker-one')));
  lease(
    capacity.acquire(
      reservation('main', {
        runId: 'run-two',
        role: 'main',
        authorizationId: undefined,
        workerParallelLimit: undefined,
      }),
    ),
  );
  assert.deepEqual(
    capacity.acquire(
      reservation('verify', {
        runId: 'run-two',
        role: 'runtime-verification',
        authorizationId: undefined,
        workerParallelLimit: undefined,
      }),
    ),
    {
      status: 'queued',
      reason: { kind: 'harness-capacity', harness: 'grok', limit: 2, occupied: 2 },
    },
  );
  lease(
    capacity.acquire(
      reservation('synthesis', {
        runId: 'run-two',
        harness: 'codex',
        role: 'main-synthesis',
        authorizationId: undefined,
        workerParallelLimit: undefined,
      }),
    ),
  );
  lease(
    capacity.acquire(
      reservation('review', {
        runId: 'run-three',
        harness: 'codex',
        role: 'review',
        authorizationId: 'authorization-two',
        workerParallelLimit: 1,
      }),
    ),
  );
  assert.deepEqual(
    capacity.acquire(
      reservation('later', {
        runId: 'run-four',
        harness: 'grok',
        authorizationId: 'authorization-three',
        workerParallelLimit: 1,
      }),
    ),
    { status: 'queued', reason: { kind: 'app-capacity', limit: 4, occupied: 4 } },
  );
});

test('worker parallel limits and canonical writer leases block only conflicting admissions', (t) => {
  const capacity = new SessionCapacity({ app: 8, perHarness: 8 });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-capacity-'))),
    first = join(root, 'first'),
    second = join(root, 'second'),
    alias = join(root, 'first-alias');
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, alias);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  lease(capacity.acquire(reservation('worker-one', { writerLeaseKey: first })));
  assert.equal(
    capacity.acquire(reservation('worker-two', { writerLeaseKey: second })).status,
    'acquired',
  );
  assert.deepEqual(capacity.acquire(reservation('worker-three')), {
    status: 'queued',
    reason: {
      kind: 'worker-parallelism',
      authorizationId: 'authorization-one',
      limit: 2,
      occupied: 2,
    },
  });
  assert.deepEqual(
    capacity.acquire(
      reservation('integration', {
        runId: 'run-two',
        role: 'main-integration',
        authorizationId: undefined,
        workerParallelLimit: undefined,
        writerLeaseKey: `${first}/`,
      }),
    ),
    {
      status: 'queued',
      reason: { kind: 'writer-lease', writerLeaseKey: first, reservationId: 'worker-one' },
    },
  );
  assert.deepEqual(
    capacity.acquire(
      reservation('integration-alias', {
        runId: 'run-two',
        role: 'main-integration',
        authorizationId: undefined,
        workerParallelLimit: undefined,
        writerLeaseKey: alias,
      }),
    ),
    {
      status: 'queued',
      reason: { kind: 'writer-lease', writerLeaseKey: first, reservationId: 'worker-one' },
    },
  );
  const renamed = join(root, 'renamed');
  renameSync(first, renamed);
  assert.equal(
    capacity.acquire(
      reservation('integration-renamed', {
        runId: 'run-two',
        role: 'main-integration',
        authorizationId: undefined,
        workerParallelLimit: undefined,
        writerLeaseKey: renamed,
      }),
    ).reason.kind,
    'writer-lease',
  );
  const replaced = join(root, 'replaced');
  mkdirSync(replaced);
  const replacement = lease(
    capacity.acquire(
      reservation('replacement', {
        writerLeaseKey: replaced,
        authorizationId: 'authorization-replacement',
      }),
    ),
  );
  rmSync(replaced, { recursive: true });
  mkdirSync(replaced);
  assert.throws(
    () =>
      capacity.acquire(
        reservation('replacement', {
          writerLeaseKey: replaced,
          authorizationId: 'authorization-replacement',
        }),
      ),
    /different identity/i,
  );
  assert.equal(
    capacity.release({
      reservationId: replacement.reservationId,
      generation: replacement.generation,
      cleanupConfirmed: true,
    }).status,
    'released',
  );
});

test('lowering limits retains active leases and blocks only new capacity', () => {
  const capacity = new SessionCapacity({ app: 4, perHarness: 4 }),
    first = lease(capacity.acquire(reservation('first'))),
    second = lease(
      capacity.acquire(
        reservation('second', { runId: 'run-two', authorizationId: 'authorization-two' }),
      ),
    );
  const snapshot = capacity.setLimits({ app: 1, perHarness: 1 });
  assert.equal(snapshot.occupied, 2);
  assert.equal(
    capacity.acquire(
      reservation('third', {
        runId: 'run-three',
        harness: 'codex',
        authorizationId: 'authorization-three',
      }),
    ).reason.kind,
    'app-capacity',
  );
  assert.equal(
    capacity.release({
      reservationId: first.reservationId,
      generation: first.generation,
      cleanupConfirmed: true,
    }).status,
    'released',
  );
  assert.equal(
    capacity.release({
      reservationId: second.reservationId,
      generation: second.generation,
      cleanupConfirmed: true,
    }).status,
    'released',
  );
  assert.equal(
    capacity.acquire(
      reservation('third', {
        runId: 'run-three',
        harness: 'codex',
        authorizationId: 'authorization-three',
      }),
    ).status,
    'acquired',
  );
});

test('exact acquire replay is idempotent while altered identities and stale releases fail', () => {
  const capacity = new SessionCapacity(),
    first = lease(capacity.acquire(reservation('same')));
  const replay = capacity.acquire(reservation('same'));
  assert.equal(replay.status, 'acquired');
  assert.equal(replay.replayed, true);
  assert.equal(capacity.snapshot().occupied, 1);
  assert.throws(
    () => capacity.acquire(reservation('same', { runId: 'other-run' })),
    /different identity/i,
  );
  capacity.release({
    reservationId: first.reservationId,
    generation: first.generation,
    cleanupConfirmed: true,
  });
  const replacement = lease(capacity.acquire(reservation('same', { runId: 'other-run' })));
  assert.throws(
    () =>
      capacity.release({
        reservationId: first.reservationId,
        generation: first.generation,
        cleanupConfirmed: true,
      }),
    /stale/i,
  );
  assert.equal(
    capacity.release({
      reservationId: replacement.reservationId,
      generation: replacement.generation,
      cleanupConfirmed: true,
    }).status,
    'released',
  );
});

test('unconfirmed cleanup quarantines occupancy until its exact generation confirms cleanup', () => {
  const capacity = new SessionCapacity({ app: 1, perHarness: 1 }),
    active = lease(capacity.acquire(reservation('quarantined')));
  assert.equal(
    capacity.release({
      reservationId: active.reservationId,
      generation: active.generation,
      cleanupConfirmed: false,
    }).status,
    'cleanup-unconfirmed',
  );
  assert.equal(capacity.snapshot().leases[0].state, 'cleanup-unconfirmed');
  assert.equal(
    capacity.acquire(
      reservation('waiting', { runId: 'run-two', authorizationId: 'authorization-two' }),
    ).reason.kind,
    'app-capacity',
  );
  assert.equal(
    capacity.release({
      reservationId: active.reservationId,
      generation: active.generation,
      cleanupConfirmed: true,
    }).status,
    'released',
  );
  assert.throws(
    () => capacity.release({ reservationId: 'missing', generation: 1, cleanupConfirmed: true }),
    /unknown/i,
  );
});

test('reservation validation rejects malformed limits, worker scopes, and noncanonical writer keys', () => {
  assert.throws(() => new SessionCapacity({ app: 0, perHarness: 2 }), /App capacity/i);
  const capacity = new SessionCapacity();
  assert.throws(
    () =>
      capacity.acquire(
        reservation('bad', { authorizationId: undefined, workerParallelLimit: undefined }),
      ),
    /require authorization/i,
  );
  assert.throws(
    () =>
      capacity.acquire(
        reservation('bad-role', {
          role: 'main-synthesis',
          authorizationId: 'authorization',
          workerParallelLimit: 1,
        }),
      ),
    /Only worker/i,
  );
  assert.throws(
    () => capacity.acquire(reservation('bad-path', { writerLeaseKey: '../workspace' })),
    /existing canonical/i,
  );
  assert.throws(
    () => capacity.acquire(reservation('bad-harness', { harness: '__proto__' })),
    /harness is unsupported/i,
  );
});

test('restores only quarantined occupancy despite reduced limits or unavailable writer paths', () => {
  const first = new SessionCapacity({ app: 4, perHarness: 4 }),
    active = lease(first.acquire(reservation('restore')));
  const quarantined = first.release({
    reservationId: active.reservationId,
    generation: active.generation,
    cleanupConfirmed: false,
  }).lease;
  const restored = new SessionCapacity({ app: 1, perHarness: 1 });
  restored.restore([quarantined]);
  assert.equal(restored.snapshot().occupied, 1);
  assert.equal(
    restored.acquire(reservation('later', { runId: 'later', authorizationId: 'later-auth' })).reason
      .kind,
    'app-capacity',
  );
  assert.throws(() => restored.restore([{ ...quarantined, state: 'active' }]), /quarantined/i);
});

test('restore rejects malformed reservation shape atomically without filesystem resolution', () => {
  const capacity = new SessionCapacity(),
    valid = {
      reservationId: 'retained',
      ownerId: 'operation',
      harness: 'codex',
      role: 'command',
      generation: 1,
      state: 'cleanup-unconfirmed',
    };
  assert.throws(
    () => capacity.restore([valid, { ...valid, reservationId: 'bad', role: 'worker' }]),
    /worker capacity/i,
  );
  assert.equal(capacity.snapshot().occupied, 0);
  assert.throws(() => capacity.restore([{ ...valid, reservationId: '  ' }]), /Reservation ID/i);
  assert.throws(
    () =>
      capacity.restore([
        {
          ...valid,
          reservationId: 'writer',
          writerLeaseKey: '/missing',
          writerWorkspaceIdentity: undefined,
        },
      ]),
    /writer identity/i,
  );
  assert.equal(
    capacity.restore([
      {
        ...valid,
        reservationId: 'missing-path',
        writerLeaseKey: '/missing',
        writerWorkspaceIdentity: '1:2',
      },
    ]).occupied,
    1,
  );
});
