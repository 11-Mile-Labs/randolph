import { lstatSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export type WorkspaceIdentity = { device: number; inode: number };
export type WorkspaceLeaseState = 'active' | 'cleanup-unconfirmed';
export type WorkspaceProvenance = {
  kind: string;
  id: string;
  projectId?: string;
  conversationId?: string;
  origin?: Record<string, unknown>;
};
export type WorkspaceLease = {
  access?: 'read' | 'write';
  provenance?: WorkspaceProvenance;
  phase?: string;
  reservationId: string;
  runId?: string;
  ownerId?: string;
  workspace: string;
  identity?: WorkspaceIdentity;
  generation: number;
  state: WorkspaceLeaseState;
  cleanupEvidence?: Record<string, unknown>;
};
export type WorkspaceLeasePort = Pick<WorkspaceLeases, 'snapshot' | 'acquire' | 'bind' | 'release'>;
export type WorkspaceLeaseAcquire =
  | { status: 'acquired'; lease: WorkspaceLease; replayed: boolean }
  | {
      status: 'blocked';
      reason: {
        kind: 'workspace-lease' | 'cleanup-unconfirmed';
        workspace: string;
        reservationId: string;
      };
    };
export type WorkspaceLeaseRelease = {
  status: 'released' | 'cleanup-unconfirmed';
  lease: WorkspaceLease | (Omit<WorkspaceLease, 'state'> & { state: 'released' });
};

const text = (value: unknown, label: string, maximum = 1_000): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`${label} must be bounded nonempty text.`);
  return value;
};
const copy = (lease: WorkspaceLease): WorkspaceLease => ({
  ...lease,
  ...(lease.identity ? { identity: { ...lease.identity } } : {}),
  ...(lease.cleanupEvidence ? { cleanupEvidence: structuredClone(lease.cleanupEvidence) } : {}),
});
const sameIdentity = (
  left: WorkspaceIdentity | undefined,
  right: WorkspaceIdentity | undefined,
): boolean => left?.device === right?.device && left?.inode === right?.inode;
const identity = (value: unknown): WorkspaceIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workspace identity is invalid.');
  const item = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(item.device) ||
    (item.device as number) < 0 ||
    !Number.isSafeInteger(item.inode) ||
    (item.inode as number) < 0
  )
    throw new Error('Workspace identity is invalid.');
  return { device: item.device as number, inode: item.inode as number };
};
function evidence(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length)
    throw new Error('Workspace cleanup evidence must be a nonempty record.');
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(value as Record<string, unknown>);
  } catch {
    throw new Error('Workspace cleanup evidence must be cloneable.');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(cloned);
  } catch {
    throw new Error('Workspace cleanup evidence must be serializable.');
  }
  if (!isDeepStrictEqual(cloned, JSON.parse(encoded)) || !Object.keys(JSON.parse(encoded)).length)
    throw new Error('Workspace cleanup evidence must be losslessly serializable.');
  if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024)
    throw new Error('Workspace cleanup evidence exceeds 16 KiB.');
  return cloned;
}
function plannedWorkspace(value: unknown): { workspace: string; identity?: WorkspaceIdentity } {
  const workspace = text(value, 'Workspace path', 2_000);
  if (
    !isAbsolute(workspace) ||
    resolve(workspace) !== workspace ||
    basename(workspace) === '.' ||
    basename(workspace) === '..'
  )
    throw new Error('Workspace path must be an absolute canonical path.');
  let parent: string;
  try {
    parent = realpathSync(dirname(workspace));
  } catch {
    throw new Error('Workspace parent cannot be observed.');
  }
  const canonical = join(parent, basename(workspace));
  if (canonical !== workspace)
    throw new Error('Workspace path was redirected or is not canonical.');
  try {
    const stat = lstatSync(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(workspace) !== workspace)
      throw new Error('Workspace path was redirected or is not a directory.');
    return { workspace, identity: { device: stat.dev, inode: stat.ino } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workspace };
    throw error;
  }
}
function retainedWorkspace(value: unknown): string {
  const workspace = text(value, 'Workspace path', 2_000);
  if (
    !isAbsolute(workspace) ||
    resolve(workspace) !== workspace ||
    basename(workspace) === '.' ||
    basename(workspace) === '..'
  )
    throw new Error('Workspace path must be an absolute canonical path.');
  return workspace;
}
function sameRequest(
  lease: WorkspaceLease,
  input: { reservationId: string; runId: string; workspace: string },
): boolean {
  return (
    lease.reservationId === input.reservationId &&
    lease.runId === input.runId &&
    lease.workspace === input.workspace
  );
}

/** Shared in-memory ownership registry; callers persist only cleanup-unconfirmed leases for reopen. */
export class WorkspaceLeases {
  private readonly leases = new Map<string, WorkspaceLease>();
  private readonly generations = new Map<string, number>();
  constructor(restored: WorkspaceLease[] = []) {
    this.restore(restored);
  }

  snapshot(): WorkspaceLease[] {
    return [...this.leases.values()]
      .map(copy)
      .sort((left, right) => left.reservationId.localeCompare(right.reservationId));
  }

  restore(entries: WorkspaceLease[]): void {
    if (!Array.isArray(entries)) throw new Error('Restored workspace leases must be a list.');
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        entry.state !== 'cleanup-unconfirmed' ||
        !Number.isSafeInteger(entry.generation) ||
        entry.generation < 1
      )
        throw new Error('Only valid cleanup-unconfirmed workspace leases may be restored.');
      const lease: WorkspaceLease = {
        reservationId: text(entry.reservationId, 'Workspace reservation ID'),
        runId: text(entry.runId, 'Workspace run ID'),
        workspace: retainedWorkspace(entry.workspace),
        generation: entry.generation,
        state: 'cleanup-unconfirmed',
        ...(entry.identity ? { identity: identity(entry.identity) } : {}),
        ...(entry.cleanupEvidence ? { cleanupEvidence: evidence(entry.cleanupEvidence) } : {}),
      };
      if (
        this.leases.has(lease.reservationId) ||
        [...this.leases.values()].some(
          (existing) =>
            existing.workspace === lease.workspace ||
            (lease.identity && sameIdentity(existing.identity, lease.identity)),
        )
      )
        throw new Error('Restored workspace lease conflicts with retained ownership.');
      this.leases.set(lease.reservationId, lease);
      this.generations.set(lease.reservationId, lease.generation);
    }
  }

  acquire(input: {
    reservationId: string;
    runId: string;
    workspace: string;
  }): WorkspaceLeaseAcquire {
    const observed = plannedWorkspace(input.workspace),
      request = {
        reservationId: text(input.reservationId, 'Workspace reservation ID'),
        runId: text(input.runId, 'Workspace run ID'),
        workspace: observed.workspace,
      },
      existing = this.leases.get(request.reservationId);
    if (existing) {
      if (!sameRequest(existing, request) || !sameIdentity(existing.identity, observed.identity))
        throw new Error('Workspace reservation ID is already active with a different identity.');
      if (existing.state === 'cleanup-unconfirmed')
        return {
          status: 'blocked',
          reason: {
            kind: 'cleanup-unconfirmed',
            workspace: existing.workspace,
            reservationId: existing.reservationId,
          },
        };
      return { status: 'acquired', lease: copy(existing), replayed: true };
    }
    const owner = [...this.leases.values()].find(
      (lease) =>
        lease.workspace === request.workspace ||
        (observed.identity && sameIdentity(lease.identity, observed.identity)),
    );
    if (owner)
      return {
        status: 'blocked',
        reason: {
          kind: owner.state === 'cleanup-unconfirmed' ? 'cleanup-unconfirmed' : 'workspace-lease',
          workspace: request.workspace,
          reservationId: owner.reservationId,
        },
      };
    const generation = (this.generations.get(request.reservationId) ?? 0) + 1,
      lease: WorkspaceLease = {
        ...request,
        ...(observed.identity ? { identity: observed.identity } : {}),
        generation,
        state: 'active',
      };
    this.generations.set(lease.reservationId, generation);
    this.leases.set(lease.reservationId, lease);
    return { status: 'acquired', lease: copy(lease), replayed: false };
  }

  bind(input: { reservationId: string; generation: number; workspace: string }): WorkspaceLease {
    const reservationId = text(input.reservationId, 'Workspace reservation ID'),
      lease = this.leases.get(reservationId);
    if (
      !lease ||
      lease.state !== 'active' ||
      !Number.isSafeInteger(input.generation) ||
      input.generation !== lease.generation
    )
      throw new Error('Workspace lease binding is stale or unknown.');
    const observed = plannedWorkspace(input.workspace);
    if (observed.workspace !== lease.workspace || !observed.identity)
      throw new Error('Workspace lease binding requires the planned workspace directory.');
    if (lease.identity && !sameIdentity(lease.identity, observed.identity))
      throw new Error('Workspace lease workspace identity changed before binding.');
    const owner = [...this.leases.values()].find(
      (candidate) =>
        candidate.reservationId !== lease.reservationId &&
        (candidate.workspace === observed.workspace ||
          sameIdentity(candidate.identity, observed.identity)),
    );
    if (owner) throw new Error('Workspace lease binding conflicts with retained ownership.');
    lease.identity = observed.identity;
    return copy(lease);
  }

  release(input: {
    reservationId: string;
    generation: number;
    cleanupConfirmed: boolean;
    cleanupEvidence?: Record<string, unknown>;
  }): WorkspaceLeaseRelease {
    const reservationId = text(input.reservationId, 'Workspace reservation ID'),
      lease = this.leases.get(reservationId),
      known = this.generations.get(reservationId);
    if (!lease) {
      if (known !== undefined && input.generation <= known)
        throw new Error('Workspace lease release is stale.');
      throw new Error('Workspace lease release is unknown.');
    }
    if (!Number.isSafeInteger(input.generation) || input.generation !== lease.generation)
      throw new Error('Workspace lease release is stale.');
    if (typeof input.cleanupConfirmed !== 'boolean')
      throw new Error('Workspace cleanup confirmation must be true or false.');
    const cleanupEvidence = evidence(input.cleanupEvidence);
    if (!input.cleanupConfirmed) {
      lease.state = 'cleanup-unconfirmed';
      lease.cleanupEvidence = cleanupEvidence;
      return { status: 'cleanup-unconfirmed', lease: copy(lease) };
    }
    this.leases.delete(reservationId);
    return { status: 'released', lease: copy({ ...lease, cleanupEvidence }) };
  }
}

export const workspaceLeaseValidation = {
  text,
  identity,
  evidence,
  plannedWorkspace,
  retainedWorkspace,
  sameIdentity,
};
