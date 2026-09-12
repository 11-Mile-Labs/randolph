import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from './contracts.js';
import { inspectGitWorkspace, runSafeGit } from './git-review.js';
import { prepareIntegration, applyIntegration, reconcileSupersededDelivery, type GitIntegrationPlan, type GitIntegrationResult } from './integration.js';
import type { Store } from './store.js';
export type IntegrationState = { status: 'applying' | 'interrupted' | 'integrated' | 'conflicted' | 'resolved'; plan: GitIntegrationPlan; result?: GitIntegrationResult; error?: string };
export class Integrations {
  constructor(private readonly store: Store, private readonly canWork: (id: string) => boolean, private readonly changed: () => void) {
    for (const run of store.runs()) if (run.integration?.status === 'applying') {
      run.integration.status = 'interrupted'; run.integration.error = 'Integration was interrupted. Explicitly continue after reviewing the retained evidence.';
      this.save(run, 'integration.interrupted');
    }
  }
  private save(run: Run, type: string): void {
    this.store.transaction(() => { this.store.putRun(run); this.store.append(run, type, run.integration?.error ?? `Parent integration ${run.integration?.status}`, { integration: run.integration }); });
    this.store.exportRun(run); this.changed();
  }
  blocksNewWork(conversationId: string): boolean {
    const status = this.latest(conversationId)?.integration?.status;
    return status === 'interrupted' || status === 'applying';
  }
  latest(conversationId: string): Run | undefined { return this.store.runs().findLast(run => run.conversationId === conversationId && run.integration); }
  update(conversationId: string): IntegrationState | null {
    if (!this.canWork(conversationId)) throw new Error('Wait for active work or cleanup to finish before integration.');
    const run = this.store.runs().findLast(item => item.conversationId === conversationId && item.executionMode === 'code');
    if (!run) throw new Error('Run a Code conversation before integration.');
    const project = this.store.projects().find(item => item.id === run.projectId)!;
    const previous = this.latest(conversationId);
    if (previous?.integration?.status === 'conflicted') throw new Error('Resolve and confirm the existing integration conflicts before updating the parent again.');
    for (const review of this.store.reviews().filter(item => item.conversationId === conversationId && item.deliveryPlan && item.status !== 'stale' && item.status !== 'delivered')) {
      if (reconcileSupersededDelivery(review.basis.root, review.basis.workspace, review.deliveryPlan!).merged) throw new Error('The earlier delivery already merged. Continue its cleanup before starting another integration.');
    }
    const owner = previous?.integration && ['interrupted', 'applying'].includes(previous.integration.status) ? previous : run;
    let plan = owner.integration && ['interrupted', 'applying'].includes(owner.integration.status) ? owner.integration.plan : undefined;
    if (!plan) {
      const basis = inspectGitWorkspace(project.root, run.workspace);
      if (basis.workspaceHead === basis.parentOid) return owner.integration ?? null;
      const dir = join(this.store.runDirectory(run), 'integrations'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      plan = prepareIntegration(project.root, run.workspace, realpathSync(dir));
    }
    owner.integration = { status: 'applying', plan };
    this.save(owner, 'integration.prepared');
    try {
      const result = applyIntegration(project.root, owner.workspace, plan);
      owner.integration = { status: result.status === 'conflicted' ? 'conflicted' : 'integrated', plan, result };
      this.save(owner, 'integration.completed'); return owner.integration;
    } catch (error) {
      owner.integration.status = 'interrupted'; owner.integration.error = error instanceof Error ? error.message : 'Integration failed.';
      this.save(owner, 'integration.failed'); throw error;
    }
  }
  confirmResolved(conversationId: string): IntegrationState {
    if (!this.canWork(conversationId)) throw new Error('Wait for active work to finish.');
    const run = this.latest(conversationId);
    if (!run?.integration || run.integration.status !== 'conflicted') throw new Error('There are no integration conflicts to confirm.');
    const plan = run.integration.plan;
    const basis = inspectGitWorkspace(plan.basis.root, run.workspace);
    if (basis.workspaceHead !== plan.basis.parentOid || basis.parentOid !== plan.basis.parentOid) throw new Error('Parent or worktree changed again. Reconcile integration before confirming resolution.');
    // Native resolution stays in ordinary files; the runtime inspects only tracked conflict paths.
    for (const path of plan.conflicts) {
      const bytes = runSafeGit(run.workspace, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--check', '--', path]);
      if (bytes.length) throw new Error('Conflict markers or whitespace errors remain in ' + path);
    }
    run.integration.status = 'resolved'; run.integration.error = undefined;
    this.save(run, 'integration.resolution-confirmed'); return run.integration;
  }
  assertReviewable(conversationId: string): void {
    const state = this.latest(conversationId)?.integration;
    if (state && ['conflicted', 'interrupted', 'applying'].includes(state.status)) throw new Error('Finish parent integration and confirm conflict resolution before review.');
  }
}
