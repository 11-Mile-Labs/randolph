import { lstatSync, realpathSync } from 'node:fs';

export type CapacityHarness = 'codex' | 'grok';
export type NativeSessionRole = 'main' | 'worker' | 'main-integration' | 'runtime-verification' | 'review' | 'main-synthesis';
export type CapacityLimits = { app: number; perHarness: number };
export type CapacityReservation = {
  reservationId: string;
  runId: string;
  harness: CapacityHarness;
  role: NativeSessionRole;
  authorizationId?: string;
  workerParallelLimit?: number;
  writerLeaseKey?: string;
};
export type CapacityLease = CapacityReservation & { generation: number; state: 'active' | 'cleanup-unconfirmed'; writerWorkspaceIdentity?: string };
export type CapacityQueueReason =
  | { kind: 'app-capacity'; limit: number; occupied: number }
  | { kind: 'harness-capacity'; harness: CapacityHarness; limit: number; occupied: number }
  | { kind: 'worker-parallelism'; authorizationId: string; limit: number; occupied: number }
  | { kind: 'writer-lease'; writerLeaseKey: string; reservationId: string };
export type CapacityAcquireResult = { status: 'acquired'; lease: CapacityLease; replayed: boolean } | { status: 'queued'; reason: CapacityQueueReason };
export type CapacityReleaseResult = { status: 'released'; lease: CapacityLease } | { status: 'cleanup-unconfirmed'; lease: CapacityLease };
export type CapacitySnapshot = { limits: CapacityLimits; occupied: number; byHarness: Partial<Record<CapacityHarness, number>>; leases: CapacityLease[] };

export const defaultCapacityLimits: CapacityLimits = { app: 4, perHarness: 2 };
const roles = new Set<NativeSessionRole>(['main', 'worker', 'main-integration', 'runtime-verification', 'review', 'main-synthesis']);
const workers = new Set<NativeSessionRole>(['worker', 'review']);

function text(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`${label} must be bounded nonempty text.`);
  return value;
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 64) throw new Error(`${label} must be a whole number from 1 through 64.`);
  return value as number;
}
function limits(value: CapacityLimits): CapacityLimits { return { app: positive(value.app, 'App capacity'), perHarness: positive(value.perHarness, 'Per-harness capacity') }; }
function same(left: CapacityReservation, right: CapacityReservation): boolean {
  return left.reservationId === right.reservationId && left.runId === right.runId && left.harness === right.harness && left.role === right.role && left.authorizationId === right.authorizationId && left.workerParallelLimit === right.workerParallelLimit && left.writerLeaseKey === right.writerLeaseKey;
}
function copy(lease: CapacityLease): CapacityLease { return { ...lease }; }
type ValidatedReservation = CapacityReservation & { writerWorkspaceIdentity?: string };
function writerWorkspace(key: string): { key: string; identity: string } {
  try {
    const real = realpathSync(key), stat = lstatSync(real);
    if (!stat.isDirectory()) throw new Error('not directory');
    return { key: real, identity: `${stat.dev}:${stat.ino}` };
  } catch { throw new Error('Writer lease key must identify an existing canonical workspace directory.'); }
}

export class SessionCapacity {
  private current: CapacityLimits;
  private readonly active = new Map<string, CapacityLease>();
  private readonly generations = new Map<string, number>();

  constructor(initial: CapacityLimits = defaultCapacityLimits) { this.current = limits(initial); }

  setLimits(next: CapacityLimits): CapacitySnapshot { this.current = limits(next); return this.snapshot(); }
  snapshot(): CapacitySnapshot {
    const leases = [...this.active.values()].map(copy).sort((left, right) => left.reservationId.localeCompare(right.reservationId));
    const byHarness: Partial<Record<CapacityHarness, number>> = {};
    for (const lease of leases) byHarness[lease.harness] = (byHarness[lease.harness] ?? 0) + 1;
    return { limits: { ...this.current }, occupied: leases.length, byHarness, leases };
  }
  acquire(input: CapacityReservation): CapacityAcquireResult {
    const reservation = this.validate(input), existing = this.active.get(reservation.reservationId);
    if (existing) {
      if (!same(existing, reservation) || existing.writerWorkspaceIdentity !== reservation.writerWorkspaceIdentity) throw new Error('Reservation ID is already active with a different identity.');
      return { status: 'acquired', lease: copy(existing), replayed: true };
    }
    const leases = [...this.active.values()];
    if (leases.length >= this.current.app) return { status: 'queued', reason: { kind: 'app-capacity', limit: this.current.app, occupied: leases.length } };
    const harnessOccupied = leases.filter(lease => lease.harness === reservation.harness).length;
    if (harnessOccupied >= this.current.perHarness) return { status: 'queued', reason: { kind: 'harness-capacity', harness: reservation.harness, limit: this.current.perHarness, occupied: harnessOccupied } };
    if (reservation.authorizationId) {
      const matching = leases.filter(lease => workers.has(lease.role) && lease.authorizationId === reservation.authorizationId);
      const workerLimit = Math.min(reservation.workerParallelLimit!, ...matching.map(lease => lease.workerParallelLimit!));
      if (matching.length >= workerLimit) return { status: 'queued', reason: { kind: 'worker-parallelism', authorizationId: reservation.authorizationId, limit: workerLimit, occupied: matching.length } };
    }
    if (reservation.writerLeaseKey) {
      const owner = leases.find(lease => lease.writerLeaseKey === reservation.writerLeaseKey || lease.writerWorkspaceIdentity === reservation.writerWorkspaceIdentity);
      if (owner) return { status: 'queued', reason: { kind: 'writer-lease', writerLeaseKey: reservation.writerLeaseKey, reservationId: owner.reservationId } };
    }
    const generation = (this.generations.get(reservation.reservationId) ?? 0) + 1, lease: CapacityLease = { ...reservation, generation, state: 'active' };
    this.generations.set(reservation.reservationId, generation); this.active.set(lease.reservationId, lease);
    return { status: 'acquired', lease: copy(lease), replayed: false };
  }
  release(input: { reservationId: string; generation: number; cleanupConfirmed: boolean }): CapacityReleaseResult {
    const reservationId = text(input.reservationId, 'Reservation ID'), lease = this.active.get(reservationId), knownGeneration = this.generations.get(reservationId);
    if (!lease) {
      if (knownGeneration !== undefined && input.generation <= knownGeneration) throw new Error('Reservation release is stale.');
      throw new Error('Reservation release is unknown.');
    }
    if (!Number.isSafeInteger(input.generation) || input.generation !== lease.generation) throw new Error('Reservation release is stale.');
    if (typeof input.cleanupConfirmed !== 'boolean') throw new Error('Cleanup confirmation must be true or false.');
    if (!input.cleanupConfirmed) { lease.state = 'cleanup-unconfirmed'; return { status: 'cleanup-unconfirmed', lease: copy(lease) }; }
    this.active.delete(reservationId); return { status: 'released', lease: copy(lease) };
  }
  private validate(input: CapacityReservation): ValidatedReservation {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Capacity reservation must be an object.');
    const role = input.role;
    if (!roles.has(role)) throw new Error('Capacity reservation role is unsupported.');
    if (input.harness !== 'codex' && input.harness !== 'grok') throw new Error('Capacity reservation harness is unsupported.');
    const reservation: ValidatedReservation = { reservationId: text(input.reservationId, 'Reservation ID'), runId: text(input.runId, 'Run ID'), harness: input.harness, role };
    const hasAuthorization = input.authorizationId !== undefined, hasWorkerLimit = input.workerParallelLimit !== undefined;
    if (workers.has(role) && !hasAuthorization) throw new Error('Worker and review reservations require authorization and parallel limits.');
    if (hasAuthorization !== hasWorkerLimit) throw new Error('Worker authorization and parallel limit must be supplied together.');
    if (hasAuthorization) {
      if (!workers.has(role)) throw new Error('Only worker and review reservations may use worker parallel limits.');
      reservation.authorizationId = text(input.authorizationId, 'Authorization ID'); reservation.workerParallelLimit = positive(input.workerParallelLimit, 'Worker parallel limit');
    }
    if (input.writerLeaseKey !== undefined) {
      const workspace = writerWorkspace(text(input.writerLeaseKey, 'Writer lease key', 1000));
      reservation.writerLeaseKey = workspace.key; reservation.writerWorkspaceIdentity = workspace.identity;
    }
    return reservation;
  }
}
