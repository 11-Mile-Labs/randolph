import { isDeepStrictEqual } from 'node:util';
import { Store } from './store.js';
import { workspaceLeaseValidation as validate, type WorkspaceLease, type WorkspaceProvenance, type WorkspaceLeaseAcquire, type WorkspaceLeasePort, type WorkspaceLeaseRelease } from './workspace-leases.js';

export type WorkspaceOwnershipRequest = { access?: 'read' | 'write'; provenance?: WorkspaceProvenance; phase?: string; reservationId: string; ownerId?: string; runId?: string; workspace: string };
type OwnedLease = Omit<WorkspaceLease, 'state'> & { ownerId: string; state: 'active' | 'cleanup-unconfirmed' | 'released'; createdAt: string; updatedAt: string };
function provenance(value: WorkspaceProvenance): WorkspaceProvenance {
  const saved = validate.evidence(value) as WorkspaceProvenance;
  validate.text(saved.kind, 'Workspace operation kind'); validate.text(saved.id, 'Workspace operation ID');
  if (saved.projectId !== undefined) validate.text(saved.projectId, 'Workspace project ID');
  if (saved.conversationId !== undefined) validate.text(saved.conversationId, 'Workspace conversation ID');
  if (saved.origin !== undefined) validate.evidence(saved.origin);
  return saved;
}
const now = () => new Date().toISOString();
const access = (value: unknown): 'read' | 'write' => value === undefined || value === 'write' ? 'write' : value === 'read' ? 'read' : (() => { throw new Error('Workspace ownership access is invalid.'); })();
const overlaps = (left: Pick<OwnedLease, 'workspace' | 'identity'>, right: Pick<OwnedLease, 'workspace' | 'identity'>): boolean => left.workspace === right.workspace || Boolean(left.identity && right.identity && validate.sameIdentity(left.identity, right.identity));
const conflicts = (left: Pick<OwnedLease, 'state' | 'access' | 'workspace' | 'identity'>, right: Pick<OwnedLease, 'state' | 'access' | 'workspace' | 'identity'>): boolean => overlaps(left, right) && (left.state === 'cleanup-unconfirmed' && right.state === 'cleanup-unconfirmed' ? false : left.access !== 'read' || right.access !== 'read');
const admissionConflict = (existing: Pick<OwnedLease, 'state' | 'access' | 'workspace' | 'identity'>, candidate: Pick<OwnedLease, 'state' | 'access' | 'workspace' | 'identity'>): boolean => overlaps(existing, candidate) && (existing.state === 'cleanup-unconfirmed' || conflicts(existing, candidate));
const copy = <T>(value: T): T => structuredClone(value);
const active = (row: OwnedLease): WorkspaceLease => {
  if (row.state === 'released') throw new Error('Terminal workspace ownership cannot be replayed; use a new reservation ID.');
  return { ...copy(row), state: row.state };
};
const blocked = (row: OwnedLease): WorkspaceLeaseAcquire => ({ status: 'blocked', reason: { kind: row.state === 'cleanup-unconfirmed' ? 'cleanup-unconfirmed' : 'workspace-lease', workspace: row.workspace, reservationId: row.reservationId } });

/** SQLite is the sole ownership authority. Reopen reconciliation is explicit and never inspects old paths. */
export class WorkspaceOwnership implements WorkspaceLeasePort {
  constructor(private readonly store: Store, private readonly origin?: Record<string, unknown>) { this.origin = origin && Object.keys(origin).length ? validate.evidence(origin) : undefined; this.rows(); }
  private rows(): OwnedLease[] {
    const records = this.store.db.prepare('SELECT id, run_id, document FROM workspace_ownership ORDER BY rowid').all() as Array<{ id: string; run_id: string | null; document: string }>;
    const leases = records.map(record => {
      const value = JSON.parse(record.document) as OwnedLease;
      if (!value || typeof value !== 'object' || Array.isArray(value) || !['active', 'cleanup-unconfirmed', 'released'].includes(value.state) || !Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error('Retained workspace ownership is invalid.');
      validate.text(value.reservationId, 'Workspace reservation ID'); validate.text(value.ownerId, 'Workspace owner ID');
      if (value.runId !== undefined) validate.text(value.runId, 'Workspace run ID');
      if (record.id !== value.reservationId || record.run_id !== (value.runId ?? null)) throw new Error('Retained workspace ownership references disagree.');
      validate.retainedWorkspace(value.workspace); validate.text(value.createdAt, 'Workspace creation time'); validate.text(value.updatedAt, 'Workspace update time');
      value.access = access(value.access);
      if (value.identity) validate.identity(value.identity);
      if (value.access === 'read' && !value.identity) throw new Error('Retained read workspace ownership lacks an observed identity.');
      if (value.provenance !== undefined) provenance(value.provenance);
      if (value.phase !== undefined) validate.text(value.phase, 'Workspace operation phase');
      if (value.cleanupEvidence !== undefined) validate.evidence(value.cleanupEvidence);
      if (value.state !== 'active' && !value.cleanupEvidence) throw new Error('Retained workspace cleanup evidence is absent.');
      return value;
    });
    const occupied = leases.filter(value => value.state !== 'released');
    for (let i = 0; i < occupied.length; i++) if (occupied.slice(i + 1).some(value => conflicts(occupied[i], value))) throw new Error('Retained workspace ownership conflicts.');
    return leases;
  }
  snapshot(): WorkspaceLease[] { return this.rows().filter(item => item.state !== 'released').map(active); }
  private put(item: OwnedLease): void { this.store.db.prepare('INSERT INTO workspace_ownership(id, run_id, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, document=excluded.document').run(item.reservationId, item.runId ?? null, JSON.stringify(item)); }
  acquire(input: WorkspaceOwnershipRequest): WorkspaceLeaseAcquire {
    const request = { access: access(input.access), reservationId: validate.text(input.reservationId, 'Workspace reservation ID'), ownerId: validate.text(input.ownerId ?? input.runId, 'Workspace owner ID'), ...(input.runId === undefined ? {} : { runId: validate.text(input.runId, 'Workspace run ID') }), workspace: validate.retainedWorkspace(input.workspace), ...(input.provenance ? { provenance: provenance({ ...input.provenance, ...(this.origin && !input.provenance.origin ? { origin: this.origin } : {}) }) } : {}), ...(input.phase === undefined ? {} : { phase: validate.text(input.phase, 'Workspace operation phase') }) };
    return this.store.transaction(() => {
      const rows = this.rows(), existing = rows.find(item => item.reservationId === request.reservationId);
      if (existing) {
        if (existing.ownerId !== request.ownerId || existing.runId !== request.runId || existing.workspace !== request.workspace || existing.access !== request.access || !isDeepStrictEqual(existing.provenance, request.provenance)) throw new Error('Workspace reservation ID is retained with different ownership.');
        if (existing.state === 'released') throw new Error('Terminal workspace ownership cannot be replayed; use a new reservation ID.');
        if (existing.state === 'cleanup-unconfirmed') return blocked(existing);
      }
      const directQuarantine = rows.find(item => item.reservationId !== request.reservationId && item.state === 'cleanup-unconfirmed' && item.workspace === request.workspace);
      if (directQuarantine) return blocked(directQuarantine);
      const observed = validate.plannedWorkspace(request.workspace);
      if (request.access === 'read' && !observed.identity) throw new Error('Read workspace ownership requires an existing observed directory.');
      const candidate = { ...request, ...observed, state: 'active' as const };
      const pathOwner = rows.find(item => item.reservationId !== request.reservationId && item.state !== 'released' && admissionConflict(item, candidate));
      if (pathOwner) return blocked(pathOwner);
      if (existing) {
        if (!validate.sameIdentity(existing.identity, observed.identity)) throw new Error('Workspace ownership identity changed.');
        return { status: 'acquired', lease: active(existing), replayed: true };
      }
      const inodeOwner = rows.find(item => item.reservationId !== request.reservationId && item.state !== 'released' && admissionConflict(item, candidate));
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
      const conflict = this.rows().find(value => value.reservationId !== item.reservationId && value.state !== 'released' && conflicts(value, { ...item, identity: observed.identity }));
      if (conflict) throw new Error('Workspace ownership identity conflicts with another reservation.');
      item.identity = observed.identity; item.updatedAt = now(); this.put(item); return active(item);
    });
  }
  assert(input: Pick<WorkspaceLease, 'reservationId' | 'generation' | 'workspace' | 'identity'>): WorkspaceLease {
    const item = this.rows().find(value => value.reservationId === input.reservationId);
    if (!item || item.state !== 'active' || item.generation !== input.generation || item.workspace !== input.workspace || !validate.sameIdentity(item.identity, input.identity)) throw new Error('Workspace ownership is stale, absent, or quarantined.');
    if (this.rows().some(value => value.reservationId !== item.reservationId && value.state === 'cleanup-unconfirmed' && overlaps(value, item))) throw new Error('Workspace ownership is blocked by uncertain cleanup from another writer.');
    const observed = validate.plannedWorkspace(item.workspace);
    if (!validate.sameIdentity(item.identity, observed.identity)) throw new Error('Workspace ownership identity changed.');
    return active(item);
  }
  stage(input: { reservationId: string; generation: number; phase: string }): WorkspaceLease {
    return this.store.transaction(() => {
      const item = this.rows().find(value => value.reservationId === input.reservationId);
      if (!item || item.state !== 'active' || item.generation !== input.generation) throw new Error('Workspace operation phase is stale or quarantined.');
      item.phase = validate.text(input.phase, 'Workspace operation phase'); item.updatedAt = now(); this.put(item); return active(item);
    });
  }
  retainUncertain(input: WorkspaceOwnershipRequest & { identity?: { device: number; inode: number }; cleanupEvidence: Record<string, unknown> }): WorkspaceLease {
    const item: OwnedLease = { access: access(input.access), reservationId: validate.text(input.reservationId, 'Workspace reservation ID'), ownerId: validate.text(input.ownerId ?? input.runId, 'Workspace owner ID'), ...(input.runId ? { runId: validate.text(input.runId, 'Workspace run ID') } : {}), workspace: validate.retainedWorkspace(input.workspace), generation: 1, state: 'cleanup-unconfirmed', cleanupEvidence: validate.evidence(input.cleanupEvidence), ...(input.identity ? { identity: validate.identity(input.identity) } : {}), ...(input.provenance ? { provenance: provenance(input.provenance) } : {}), ...(input.phase ? { phase: validate.text(input.phase, 'Workspace operation phase') } : {}), createdAt: now(), updatedAt: now() };
    if (item.access === 'read' && !item.identity) throw new Error('Read workspace uncertainty requires the retained observed identity.');
    return this.store.transaction(() => {
      const rows = this.rows(), existing = rows.find(value => value.reservationId === item.reservationId);
      if (existing) {
        if (existing.ownerId !== item.ownerId || existing.runId !== item.runId || existing.workspace !== item.workspace || existing.access !== item.access || !validate.sameIdentity(existing.identity, item.identity) || !isDeepStrictEqual(existing.provenance, item.provenance)) throw new Error('Retained workspace witness changed its original ownership.');
        if (existing.state === 'released') throw new Error('Terminal workspace witness cannot be recreated.');
        if (existing.state !== 'cleanup-unconfirmed') throw new Error('Only uncertain workspace ownership can be imported.');
        return active(existing);
      }
      if (rows.some(value => value.state === 'active' && overlaps(value, item))) throw new Error('Uncertain workspace import conflicts with active ownership.');
      this.put(item); return active(item);
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
