import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import type { Store } from './store.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceLease, WorkspaceProvenance } from './workspace-leases.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import type { Run } from './contracts.js';

export type PlannedWorkspace = { parent: WorkspaceLease; lease: WorkspaceLease; workspace: string };

export class RunWorkspace {
  private readonly preparations = new Set<Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly ownership: WorkspaceOwnership,
    private readonly settle: (run: Run, status: Run['status'], error?: string) => void,
  ) {}

  preparation(): () => void {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.preparations.add(pending);
    return () => {
      this.preparations.delete(pending);
      complete();
    };
  }

  async wait(): Promise<void> {
    await Promise.all(this.preparations);
  }

  own(
    workspace: string,
    provenance: WorkspaceProvenance,
    held: Map<string, WorkspaceLease>,
    access: 'read' | 'write' = 'write',
  ): WorkspaceLease {
    const acquired = this.ownership.acquire({
      reservationId: randomUUID(),
      ownerId: provenance.id,
      workspace,
      provenance,
      phase: 'preparation',
      access,
    });
    if (acquired.status !== 'acquired')
      throw new Error(
        'This workspace is owned by active work or unconfirmed cleanup. Reconcile the original operation before continuing.',
      );
    held.set(acquired.lease.reservationId, acquired.lease);
    return acquired.lease;
  }

  plan(
    root: string,
    provenance: WorkspaceProvenance,
    plan: () => string,
    held: Map<string, WorkspaceLease>,
    readOnlyPlanning = false,
  ): PlannedWorkspace {
    let parent = this.own(root, provenance, held, readOnlyPlanning ? 'read' : 'write');
    let workspace = plan();
    this.ownership.assert(parent);
    if (workspace === root) return { parent, lease: parent, workspace };
    if (readOnlyPlanning) {
      const promoted = this.store.transaction(() => {
        this.ownership.release({
          ...parent,
          cleanupConfirmed: true,
          cleanupEvidence: { operation: 'workspace-planning', outcome: 'read-only-probe-returned' },
        });
        const acquired = this.ownership.acquire({
          reservationId: randomUUID(),
          ownerId: provenance.id,
          workspace: root,
          provenance,
          phase: 'workspace-preparation',
          access: 'write',
        });
        if (acquired.status !== 'acquired')
          throw new Error(
            'Workspace preparation is waiting for other readers or writers to settle.',
          );
        return acquired.lease;
      });
      held.delete(parent.reservationId);
      held.set(promoted.reservationId, promoted);
      parent = promoted;
      workspace = plan();
      this.ownership.assert(parent);
      if (workspace === root) return { parent, lease: parent, workspace };
    }
    const base = join(root, '.worktrees');
    mkdirSync(base, { recursive: true });
    if (realpathSync(base) !== base) throw new Error('Project worktree directory was redirected.');
    const lease = this.own(workspace, provenance, held);
    return { parent, lease, workspace };
  }

  release(held: Map<string, WorkspaceLease>, failure?: unknown): void {
    const cleanupConfirmed = workspaceCleanupConfirmed(failure);
    this.store.transaction(() => {
      for (const lease of held.values())
        this.ownership.release({
          reservationId: lease.reservationId,
          generation: lease.generation,
          cleanupConfirmed,
          cleanupEvidence: {
            operation: lease.provenance?.kind ?? 'runtime',
            phase: lease.phase ?? 'preparation',
            runtimeCleanupConfirmed: cleanupConfirmed,
            outcome: failure instanceof Error ? failure.message : failure ? 'failed' : 'returned',
          },
        });
    });
    held.clear();
  }

  observe(run: Run, work: Promise<void>): Promise<void> {
    return (async () => {
      try {
        await work;
      } catch (error) {
        run.cleanupUnconfirmed = true;
        try {
          this.settle(
            run,
            'stop-unconfirmed',
            `Workspace settlement failed: ${error instanceof Error ? error.message : 'unknown failure'}`,
          );
        } catch {
          /* The retained ownership row continues to block admission if SQLite is unavailable. */
        }
      }
    })();
  }

  transfer(
    plan: Pick<PlannedWorkspace, 'parent' | 'lease'>,
    held: Map<string, WorkspaceLease>,
  ): WorkspaceLease {
    const lease = this.ownership.bind(plan.lease);
    this.ownership.assert(plan.parent);
    if (plan.parent.reservationId !== lease.reservationId) {
      this.release(new Map([[plan.parent.reservationId, plan.parent]]));
      held.delete(plan.parent.reservationId);
    }
    held.delete(lease.reservationId);
    return lease;
  }
}
