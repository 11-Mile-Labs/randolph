import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCapacity } from '../dist/session-capacity.js';
import { NativeAdmissionQueue } from '../dist/native-admission-queue.js';

const reservation = (id, harness = 'codex') => ({
  reservationId: id,
  runId: id,
  harness,
  role: 'main',
});
const request = (id, options = {}) => ({
  reservation: reservation(id),
  priority: () => 0,
  assertCurrent: () => {},
  queued: () => {},
  ...options,
});

test('priority changes choose the next free seat, while another blocked harness does not stall available seats', async () => {
  const capacity = new SessionCapacity({ app: 3, perHarness: 1 }),
    queue = new NativeAdmissionQueue(capacity);
  const occupied = await queue.acquire(request('occupied'));
  let priority = 0;
  const first = queue.acquire(request('first', { priority: () => priority }));
  const second = queue.acquire(request('second', { priority: () => 2 }));
  const other = await queue.acquire(
    request('other', { reservation: reservation('other', 'grok') }),
  );
  priority = 3;
  queue.release(occupied, true);
  const next = await first;
  assert.equal(next.reservationId, 'first');
  queue.release(next, true);
  const last = await second;
  assert.equal(last.reservationId, 'second');
  queue.release(last, true);
  queue.release(other, true);
  assert.equal(capacity.snapshot().occupied, 0);
});

test('cancelled generation cannot take a released seat and quarantined cleanup retains occupancy', async () => {
  const capacity = new SessionCapacity({ app: 1, perHarness: 1 }),
    queue = new NativeAdmissionQueue(capacity);
  const occupied = await queue.acquire(request('occupied'));
  let valid = true;
  const reasons = [];
  const waiting = queue.acquire(
    request('waiting', {
      assertCurrent: () => {
        if (!valid) throw new Error('stale generation');
      },
      queued: (reason) => reasons.push(reason.kind),
    }),
  );
  const rejected = assert.rejects(waiting, /stale generation/);
  queue.release(occupied, false);
  assert.equal(capacity.snapshot().occupied, 1);
  valid = false;
  queue.drain();
  await rejected;
  assert.deepEqual(reasons, ['app-capacity']);
  assert.equal(capacity.snapshot().leases[0].state, 'cleanup-unconfirmed');
});

test('a replayed reservation never becomes another executable admission', async () => {
  const capacity = new SessionCapacity(),
    queue = new NativeAdmissionQueue(capacity);
  const occupied = await queue.acquire(request('same'));
  await assert.rejects(queue.acquire(request('same')), /cannot authorize another launch/);
  assert.equal(capacity.snapshot().occupied, 1);
  queue.release(occupied, true);
});
