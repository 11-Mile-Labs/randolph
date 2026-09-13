import { SessionCapacity, type CapacityLease, type CapacityQueueReason, type CapacityReservation } from './session-capacity.js';

type Request = { reservation: CapacityReservation; priority: () => number; assertCurrent: () => void; queued: (reason: CapacityQueueReason) => void };
type Pending = Request & { order: number; resolve: (lease: CapacityLease) => void; reject: (error: unknown) => void; lastReason?: string };

/** A waiting request owns neither a process nor an execution-budget activity. */
export class NativeAdmissionQueue {
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private draining = false;
  private redrain = false;
  constructor(readonly capacity: SessionCapacity) {}

  acquire(request: Request): Promise<CapacityLease> {
    if (this.pending.has(request.reservation.reservationId)) return Promise.reject(new Error('Native admission request is already queued.'));
    return new Promise((resolve, reject) => {
      this.pending.set(request.reservation.reservationId, { ...request, order: this.sequence++, resolve, reject });
      this.drain();
    });
  }

  drain(): void {
    if (this.draining) { this.redrain = true; return; }
    do {
      this.redrain = false;
      this.draining = true;
      try {
        const requests: Array<{ request: Pending; priority: number }> = [];
        for (const request of this.pending.values()) {
          try { request.assertCurrent(); const priority = request.priority(); if (!Number.isFinite(priority)) throw new Error('Native queue priority is invalid.'); requests.push({ request, priority }); }
          catch (error) { this.pending.delete(request.reservation.reservationId); request.reject(error); }
        }
        requests.sort((a, b) => b.priority - a.priority || a.request.order - b.request.order);
        for (const { request } of requests) {
          let lease: CapacityLease | undefined;
          try {
            request.assertCurrent();
            const result = this.capacity.acquire(request.reservation);
            if (result.status === 'queued') {
              const reason = JSON.stringify(result.reason);
              if (reason !== request.lastReason) { request.queued(result.reason); request.lastReason = reason; }
              continue;
            }
            if (result.replayed) throw new Error('An existing native reservation cannot authorize another launch.');
            lease = result.lease;
            request.assertCurrent();
            this.pending.delete(request.reservation.reservationId); request.resolve(lease);
          } catch (error) {
            if (lease) this.capacity.release({ reservationId: lease.reservationId, generation: lease.generation, cleanupConfirmed: true });
            this.pending.delete(request.reservation.reservationId); request.reject(error);
          }
        }
      } finally { this.draining = false; }
    } while (this.redrain);
  }

  release(lease: CapacityLease, cleanupConfirmed: boolean): void {
    this.capacity.release({ reservationId: lease.reservationId, generation: lease.generation, cleanupConfirmed });
    this.drain();
  }
}
