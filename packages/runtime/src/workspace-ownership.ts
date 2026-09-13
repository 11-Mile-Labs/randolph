import { Store } from './store.js';
import { workspaceLeaseValidation as validate, type WorkspaceLease, type WorkspaceLeaseAcquire, type WorkspaceLeasePort, type WorkspaceLeaseRelease } from './workspace-leases.js';

export type WorkspaceOwnershipRequest = { reservationId: string; ownerId?: string; runId?: string; workspace: string };
type OwnedLease = Omit<WorkspaceLease, 'state'> & { ownerId: string; state: 'active' | 'cleanup-unconfirmed' | 'released'; createdAt: string; updatedAt: string };
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
const active = (row: OwnedLease): WorkspaceLease => {
  if (row.state === 'released') throw new Error('Terminal workspace ownership cannot be replayed; use a new reservation ID.');
  return { ...copy(row), state: row.state };
};
const blocked = (row: OwnedLease): WorkspaceLeaseAcquire => ({ status: 'blocked', reason: { kind: row.state === 'cleanup-unconfirmed' ? 'cleanup-unconfirmed' : 'workspace-lease', workspace: row.workspace, reservationId: row.reservationId } });

/** SQLite is the sole ownership authority. Reopen reconciliation is explicit and never inspects old paths. */
export class WorkspaceOwnership implements WorkspaceLeasePort {
  constructor(private readonly store: Store) { this.rows(); }
  private rows(): OwnedLease[] {
    const records = this.store.db.prepare('SELECT id, run_id, document FROM workspace_ownership ORDER BY rowid').all() as Array<{ id: string; run_id: string | null; document: string }>;
    const leases = records.map(record => {
      const value = JSON.parse(record.document) as OwnedLease;
      if (!value || typeof value !== 'object' || Array.isArray(value) || !['active', 'cleanup-unconfirmed', 'released'].includes(value.state) || !Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error('Retained workspace ownership is invalid.');
      validate.text(value.reservationId, 'Workspace reservation ID'); validate.text(value.ownerId, 'Workspace owner ID');
      if (value.runId !== undefined) validate.text(value.runId, 'Workspace run ID');
      if (record.id !== value.reservationId || record.run_id !== (value.runId ?? null)) throw new Error('Retained workspace ownership references disagree.');
      validate.retainedWorkspace(value.workspace); validate.text(value.createdAt, 'Workspace creation time'); validate.text(value.updatedAt, 'Workspace update time');
      if (value.identity) validate.identity(value.identity);
      if (value.cleanupEvidence !== undefined) validate.evidence(value.cleanupEvidence);
      if (value.state !== 'active' && !value.cleanupEvidence) throw new Error('Retained workspace cleanup evidence is absent.');
      return value;
    });
    const occupied = leases.filter(value => value.state !== 'released');
    for (let i = 0; i < occupied.length; i++) if (occupied.slice(i + 1).some(value => value.workspace === occupied[i].workspace || occupied[i].identity && validate.sameIdentity(value.identity, occupied[i].identity))) throw new Error('Retained workspace ownership conflicts.');
    return leases;
  }
  snapshot(): WorkspaceLease[] { return this.rows().filter(item => item.state !== 'released').map(active); }
  private put(item: OwnedLease): void { this.store.db.prepare('INSERT INTO workspace_ownership(id, run_id, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, document=excluded.document').run(item.reservationId, item.runId ?? null, JSON.stringify(item)); }
  acquire(input: WorkspaceOwnershipRequest): WorkspaceLeaseAcquire {
    const request = { reservationId: validate.text(input.reservationId, 'Workspace reservation ID'), ownerId: validate.text(input.ownerId ?? input.runId, 'Workspace owner ID'), ...(input.runId === undefined ? {} : { runId: validate.text(input.runId, 'Workspace run ID') }), workspace: validate.retainedWorkspace(input.workspace) };
    return this.store.transaction(() => {
      const rows = this.rows(), existing = rows.find(item => item.reservationId === request.reservationId);
      if (existing) {
        if (existing.ownerId !== request.ownerId || existing.runId !== request.runId || existing.workspace !== request.workspace) throw new Error('Workspace reservation ID is retained with different ownership.');
        if (existing.state === 'released') throw new Error('Terminal workspace ownership cannot be replayed; use a new reservation ID.');
        if (existing.state === 'cleanup-unconfirmed') return blocked(existing);
      }
      const pathOwner = rows.find(item => item.reservationId !== request.reservationId && item.state !== 'released' && item.workspace === request.workspace);
      if (pathOwner) return blocked(pathOwner);
      const observed = validate.plannedWorkspace(request.workspace);
      if (existing) {
        if (!validate.sameIdentity(existing.identity, observed.identity)) throw new Error('Workspace ownership identity changed.');
        return { status: 'acquired', lease: active(existing), replayed: true };
      }
      const inodeOwner = rows.find(item => item.state !== 'released' && observed.identity && validate.sameIdentity(item.identity, observed.identity));
      if (inodeOwner) return blocked(inodeOwner);
      const item: OwnedLease = { ...request, ...observed, generation: 1, state: 'active', createdAt: now(), updatedAt: now() };
      this.put(item); return { status: 'acquired', lease: active(item), replayed: false };
    });
  }
  acquireMany(input: WorkspaceOwnershipRequest[]): WorkspaceLeaseAcquire[] {
    const requests = copy(input);
    return this.store.transaction(() => {
      if (!Array.isArray(requests) || !requests.length || new Set(requests.map(item => item.reservationId)).size !== requests.length) throw new Error('Workspace ownership batch is invalid.');
      const results = requests.map(item => this.acquire(item));
      if (results.some(item => item.status === 'blocked')) throw new Error('Workspace ownership batch could not acquire every reservation.');
      return results;
    });
  }
  bind(input: { reservationId: string; generation: number; workspace: string }): WorkspaceLease {
    return this.store.transaction(() => {
      const item = this.rows().find(value => value.reservationId === input.reservationId);
      if (!item || item.state !== 'active' || item.generation !== input.generation) throw new Error('Workspace ownership binding is stale or invalid.');
      const observed = validate.plannedWorkspace(input.workspace);
      if (item.workspace !== observed.workspace || !observed.identity) throw new Error('Workspace binding requires the planned directory.');
      if (item.identity && !validate.sameIdentity(item.identity, observed.identity)) throw new Error('Workspace ownership identity changed.');
      const conflict = this.rows().find(value => value.reservationId !== item.reservationId && value.state !== 'released' && (value.workspace === observed.workspace || validate.sameIdentity(value.identity, observed.identity)));
      if (conflict) throw new Error('Workspace ownership identity conflicts with another reservation.');
      item.identity = observed.identity; item.updatedAt = now(); this.put(item); return active(item);
    });
  }
  release(input: { reservationId: string; generation: number; cleanupConfirmed: boolean; cleanupEvidence?: Record<string, unknown> }): WorkspaceLeaseRelease {
    return this.store.transaction(() => {
      const item = this.rows().find(value => value.reservationId === input.reservationId);
      if (!item || item.generation !== input.generation || item.state === 'released' || typeof input.cleanupConfirmed !== 'boolean') throw new Error('Workspace ownership release is stale or invalid.');
      item.cleanupEvidence = validate.evidence(input.cleanupEvidence); item.updatedAt = now();
      item.state = input.cleanupConfirmed ? 'released' : 'cleanup-unconfirmed'; this.put(item);
      return { status: item.state, lease: copy(item) };
    });
  }
  reconcileOnReopen(): WorkspaceLease[] {
    return this.store.transaction(() => {
      const changed: WorkspaceLease[] = [];
      for (const item of this.rows()) if (item.state === 'active') {
        item.state = 'cleanup-unconfirmed'; item.cleanupEvidence = { reconciliation: 'reopen-active-workspace', runtimeCleanupConfirmed: false }; item.updatedAt = now(); this.put(item); changed.push(active(item));
      }
      return changed;
    });
  }
}
