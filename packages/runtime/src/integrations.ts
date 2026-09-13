import { mkdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Run } from './contracts.js';
import { inspectGitWorkspace, runSafeGit } from './git-review.js';
import { prepareIntegration, applyIntegration, reconcileSupersededDelivery, type GitIntegrationPlan, type GitIntegrationResult } from './integration.js';
import type { Store } from './store.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
export type IntegrationState = { status: 'applying' | 'interrupted' | 'integrated' | 'conflicted' | 'resolved'; plan: GitIntegrationPlan; result?: GitIntegrationResult; error?: string };

export class Integrations {
  constructor(private readonly store: Store, private readonly canWork: (id: string) => boolean, private readonly changed: () => void, private readonly ownership = new WorkspaceOwnership(store)) {
    for (const run of store.runs()) if (run.integration?.status === 'applying') {
      run.integration.status = 'interrupted'; run.integration.error = 'Integration was interrupted. Explicitly continue after reviewing the retained evidence.';
      this.save(run, 'integration.interrupted');
    }
  }
  private save(run: Run, type: string): void {
    this.store.transaction(() => { this.store.putRun(run); this.store.append(run, type, run.integration?.error ?? `Parent integration ${run.integration?.status}`, { integration: run.integration }); });
    this.store.exportRun(run); this.changed();
  }
  private acquire(owner: Run, workspace: string, root: string, stage: string) {
    const acquired = this.ownership.acquireMany([
      { reservationId: randomUUID(), ownerId: `integration:${owner.id}`, runId: owner.id, workspace, provenance: { kind: 'integration', id: owner.id }, phase: stage },
      { reservationId: randomUUID(), ownerId: `integration:${owner.id}`, runId: owner.id, workspace: root, provenance: { kind: 'integration', id: owner.id }, phase: stage },
    ]);
    const leases = acquired.map(item => { if (item.status !== 'acquired') throw new Error('Integration workspace ownership is unavailable.'); return item.lease; });
    let cleanupConfirmed = true;
    try { for (const lease of leases) { this.ownership.assert(lease); this.ownership.bind({ reservationId: lease.reservationId, generation: lease.generation, workspace: lease.workspace }); this.ownership.stage({ reservationId: lease.reservationId, generation: lease.generation, phase: stage }); } }
    catch (error) { cleanupConfirmed = workspaceCleanupConfirmed(error); for (const lease of leases) this.ownership.release({ reservationId: lease.reservationId, generation: lease.generation, cleanupConfirmed, cleanupEvidence: cleanupConfirmed ? { stage, cleanup: 'initialization-failed' } : { stage, cleanup: 'unconfirmed' } }); throw error; }
    return { leases, uncertain: (error: unknown) => { cleanupConfirmed &&= workspaceCleanupConfirmed(error); }, release: () => { for (const lease of leases) this.ownership.release({ reservationId: lease.reservationId, generation: lease.generation, cleanupConfirmed, cleanupEvidence: cleanupConfirmed ? { stage, status: owner.integration?.status ?? 'none' } : { stage, cleanup: 'unconfirmed' } }); } };
  }
  blocksNewWork(conversationId: string): boolean { const status = this.latest(conversationId)?.integration?.status; return status === 'interrupted' || status === 'applying'; }
  latest(conversationId: string): Run | undefined { return this.store.runs().findLast(run => run.conversationId === conversationId && run.integration); }
  update(conversationId: string): IntegrationState | null {
    if (!this.canWork(conversationId)) throw new Error('Wait for active work or cleanup to finish before integration.');
    const run = this.store.runs().findLast(item => item.conversationId === conversationId && item.executionMode === 'code');
    if (!run) throw new Error('Run a Code conversation before integration.');
    const project = this.store.projects().find(item => item.id === run.projectId)!;
    const previous = this.latest(conversationId);
    if (previous?.integration?.status === 'conflicted') throw new Error('Resolve and confirm the existing integration conflicts before updating the parent again.');
    for (const review of this.store.reviews().filter(item => item.conversationId === conversationId && item.deliveryPlan && item.status !== 'stale' && item.status !== 'delivered')) if (reconcileSupersededDelivery(review.basis.root, review.basis.workspace, review.deliveryPlan!).merged) throw new Error('The earlier delivery already merged. Continue its cleanup before starting another integration.');
    const owner = previous?.integration && ['interrupted', 'applying'].includes(previous.integration.status) ? previous : run;
    const lock = this.acquire(owner, run.workspace, project.root, 'integration');
    try {
      let plan = owner.integration && ['interrupted', 'applying'].includes(owner.integration.status) ? owner.integration.plan : undefined;
      if (!plan) {
        const basis = inspectGitWorkspace(project.root, run.workspace);
        if (basis.workspaceHead === basis.parentOid) return owner.integration ?? null;
        const dir = join(this.store.runDirectory(run), 'integrations'); mkdirSync(dir, { recursive: true, mode: 0o700 });
        plan = prepareIntegration(project.root, run.workspace, realpathSync(dir));
      }
      owner.integration = { status: 'applying', plan }; this.save(owner, 'integration.prepared');
      try {
        const result = applyIntegration(project.root, owner.workspace, plan);
        owner.integration = { status: result.status === 'conflicted' ? 'conflicted' : 'integrated', plan, result };
        this.save(owner, 'integration.completed'); return owner.integration;
      } catch (error) {
        lock.uncertain(error);
        owner.integration.status = 'interrupted'; owner.integration.error = error instanceof Error ? error.message : 'Integration failed.';
        this.save(owner, 'integration.failed'); throw error;
      }
    } catch (error) { lock.uncertain(error); throw error; } finally { lock.release(); }
  }
  confirmResolved(conversationId: string): IntegrationState {
    if (!this.canWork(conversationId)) throw new Error('Wait for active work to finish.');
    const run = this.latest(conversationId);
    if (!run?.integration || run.integration.status !== 'conflicted') throw new Error('There are no integration conflicts to confirm.');
    const plan = run.integration.plan, lock = this.acquire(run, run.workspace, plan.basis.root, 'integration-confirm');
    try {
      const basis = inspectGitWorkspace(plan.basis.root, run.workspace);
      if (basis.workspaceHead !== plan.basis.parentOid || basis.parentOid !== plan.basis.parentOid) throw new Error('Parent or worktree changed again. Reconcile integration before confirming resolution.');
      for (const path of plan.conflicts) {
        const bytes = runSafeGit(run.workspace, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--check', '--', path]);
        if (bytes.length) throw new Error('Conflict markers or whitespace errors remain in ' + path);
      }
      run.integration.status = 'resolved'; run.integration.error = undefined; this.save(run, 'integration.resolution-confirmed'); return run.integration;
    } catch (error) { lock.uncertain(error); throw error; } finally { lock.release(); }
  }
  assertReviewable(conversationId: string): void { const state = this.latest(conversationId)?.integration; if (state && ['conflicted', 'interrupted', 'applying'].includes(state.status)) throw new Error('Finish parent integration and confirm conflict resolution before review.'); }
}
