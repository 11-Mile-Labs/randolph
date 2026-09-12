import { reconcileSupersededDelivery } from './integration.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ApproveReviewInput, HarnessAdapter, ReviewRecord, Run } from './contracts.js';
import { Store } from './store.js';
import { cleanupGitDelivery, commitGitDelivery, createGitDeliveryPlan, createGitReview, mergeGitDelivery, reconcileGitDelivery } from './git-review.js';
import { detectVerificationCommands, runVerification } from './verification.js';

const now = (): string => new Date().toISOString();
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Review operation failed.';

export class Reviews {
  private readonly checking = new Map<string, { controller: AbortController; done: Promise<ReviewRecord> }>();
  private readonly busy = new Set<string>();
  private accepting = true;

  constructor(private readonly store: Store, private readonly adapterFor: (run: Run) => HarnessAdapter, private readonly canWork: (conversationId: string) => boolean, private readonly changed: () => void) {
    for (const review of store.reviews()) {
      if (review.status === 'checking' || review.status === 'delivering') {
        review.status = review.status === 'checking' ? 'stop-unconfirmed' : 'interrupted';
        review.error = 'The app ended during this operation. Nothing has resumed. Review the evidence and explicitly continue.';
        this.save(review, 'review.interrupted', review.error);
      }
    }
  }

  hasActiveWork(conversationId?: string): boolean {
    return conversationId ? this.busy.has(conversationId) || this.store.reviews().some(review => review.conversationId === conversationId && review.status === 'stop-unconfirmed') : this.busy.size > 0;
  }
  private get(id: string): ReviewRecord {
    const review = this.store.reviews().find(item => item.id === id);
    if (!review) throw new Error('Review does not exist.');
    return review;
  }
  private run(review: ReviewRecord): Run {
    const run = this.store.runs().find(item => item.id === review.runId);
    if (!run) throw new Error('Review run does not exist.');
    return run;
  }
  private save(review: ReviewRecord, type: string, summary: string, data: Record<string, unknown> = {}): void {
    review.updatedAt = now();
    const run = this.run(review);
    this.store.transaction(() => {
      this.store.putReview(review);
      this.store.append(run, type, summary, { reviewId: review.id, ...data });
    });
    this.store.exportRun(run);
    this.changed();
  }
  private assertIdle(conversationId: string): void {
    if (!this.accepting) throw new Error('Application is closing.');
    if (!this.canWork(conversationId) || this.hasActiveWork(conversationId)) throw new Error('Wait for active conversation work or checks to finish.');
  }
  invalidate(conversationId: string): void {
    for (const review of this.store.reviews().filter(item => item.conversationId === conversationId && item.status === 'pending')) {
      review.status = 'stale';
      this.save(review, 'review.stale', 'New work invalidated the previous review.');
    }
  }
  prepare(conversationId: string): ReviewRecord {
    this.assertIdle(conversationId);
    const run = this.store.runs().findLast(item => item.conversationId === conversationId && item.executionMode === 'code');
    if (!run) throw new Error('Run a Code conversation before requesting review.');
    if (run.status === 'stop-unconfirmed') throw new Error('Process cleanup must be confirmed before review.');
    const project = this.store.projects().find(item => item.id === run.projectId);
    if (!project) throw new Error('Project does not exist.');
    const priorDeliveries = this.store.reviews().filter(review => review.conversationId === conversationId && review.deliveryPlan && review.status !== 'delivered' && review.status !== 'stale');
    for (const prior of priorDeliveries) {
      if (reconcileSupersededDelivery(prior.basis.root, prior.basis.workspace, prior.deliveryPlan!).merged) throw new Error('The earlier delivery already merged. Continue its cleanup before requesting a new review.');
    }
    let evidenceDir = join(this.store.runDirectory(run), 'reviews');
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    evidenceDir = realpathSync(evidenceDir);
    const basis = createGitReview(project.root, run.workspace, evidenceDir);
    if (!basis.files.length) throw new Error('No changes to review.');
    for (const prior of priorDeliveries) {
      prior.status = 'stale';
      this.save(prior, 'delivery.superseded', 'Unmerged delivery intent replaced by a fresh review. The earlier approval cannot be used again.');
    }
    this.invalidate(conversationId);
    const review: ReviewRecord = { id: randomUUID(), projectId: project.id, conversationId, runId: run.id, createdAt: now(), updatedAt: now(), status: 'pending', basis };
    this.save(review, 'review.created', 'Changes are ready for checks and final review.', { treeOid: basis.treeOid, parentOid: basis.parentOid, files: basis.files.length });
    return review;
  }
  private assertCurrent(review: ReviewRecord): void {
    const current = createGitReview(review.basis.root, review.basis.workspace, review.basis.evidenceDir);
    if (current.treeOid !== review.basis.treeOid || current.parentOid !== review.basis.parentOid || current.parentBranch !== review.basis.parentBranch || current.workspaceHead !== review.basis.workspaceHead) {
      review.status = 'stale';
      this.save(review, 'review.stale', 'The worktree or parent changed. Request a fresh review.');
      throw new Error('Review is stale: worktree or parent changed. Request a fresh review.');
    }
  }
  async verify(id: string): Promise<ReviewRecord> {
    const review = this.get(id); this.assertIdle(review.conversationId);
    if (review.status !== 'pending' && review.status !== 'interrupted') throw new Error('Request a fresh review before running checks.');
    if (review.deliveryPlan) throw new Error('Delivery is pending; continue that delivery before running new checks.');
    if (!this.adapterFor(this.run(review)).runCommand) throw new Error('This run\'s harness has no verified command execution capability.');
    this.assertCurrent(review);
    this.busy.add(review.conversationId);
    const controller = new AbortController();
    const done = this.runChecks(review, controller);
    this.checking.set(id, { controller, done });
    try { return await done; }
    finally { this.checking.delete(id); this.busy.delete(review.conversationId); this.changed(); }
  }
  private async runChecks(review: ReviewRecord, controller: AbortController): Promise<ReviewRecord> {
    try {
      review.status = 'checking'; review.error = undefined;
      this.save(review, 'verification.started', 'Running project checks through the native permission boundary.');
      const run = this.store.runs().find(candidate => candidate.id === review.runId);
      if (!run) throw new Error('The reviewed run no longer exists.');
      const adapter = this.adapterFor(run);
      if (!adapter.runCommand) throw new Error('This run\'s harness has no verified command execution capability.');
      const commands = await detectVerificationCommands(review.basis.workspace);
      review.verification = await runVerification(review.basis.workspace, commands, {
        signal: controller.signal,
        executor: async (workspace, command, options) => adapter.runCommand!({ executable: run.executable, executableVersion: run.executableVersion, workspace, command: [command.command, ...command.args], signal: options.signal, onOutput: options.onOutput }),
        onEvent: event => {
          if (event.type === 'check-started') review.progress = { checkId: event.checkId, startedAt: now(), output: '' };
          if (event.type === 'check-output') {
            if (review.progress) review.progress.output = (review.progress.output + (event.output ?? '')).slice(-64 * 1024);
            this.save(review, 'verification.progress', `Checking ${event.checkId}`, { checkId: event.checkId });
          } else this.save(review, `verification.${event.type}`, event.type === 'check-started' ? `Checking ${event.checkId}` : `Check ${event.checkId} ${event.result?.status ?? 'finished'}`, { checkId: event.checkId, ...(event.result ? { result: event.result } : {}) });
        },
      });
      if (review.verification.checks.some(check => !check.cleanupVerified)) {
        review.status = 'stop-unconfirmed';
        review.error = 'Check process cleanup could not be confirmed. Further work in this conversation is blocked, including after reopening.';
        this.save(review, 'verification.stop-unconfirmed', review.error);
        return review;
      }
      this.assertCurrent(review);
      review.status = 'pending';
      this.save(review, 'verification.completed', `Project checks ${review.verification.status}.`, { status: review.verification.status });
      return review;
    } catch (error) {
      if (review.status !== 'stale' && review.status !== 'stop-unconfirmed') review.status = 'failed';
      review.error = errorText(error);
      this.save(review, 'verification.failed', review.error);
      throw error;
    }
  }
  async approve(input: ApproveReviewInput): Promise<ReviewRecord> {
    const review = this.get(input.reviewId);
    if (review.status === 'delivered' && review.cleaned) return review;
    this.assertIdle(review.conversationId);
    if (review.status === 'stale' || review.status === 'stop-unconfirmed') throw new Error('Request a fresh review before final approval.');
    if (!review.deliveryPlan && review.status !== 'pending') throw new Error('Request a fresh review before final approval.');
    if (review.verification?.status !== 'passed') throw new Error('Successful project checks are required before final approval.');
    this.busy.add(review.conversationId);
    try {
      if (!review.deliveryPlan) {
        this.assertCurrent(review);
        review.deliveryPlan = createGitDeliveryPlan(review.basis.root, review.basis.workspace, review.basis, input.message);
        review.status = 'delivering'; review.error = undefined;
        this.save(review, 'delivery.approved', 'Final approval recorded for this exact commit and parent.', { commitOid: review.deliveryPlan.commitOid, treeOid: review.basis.treeOid, parentOid: review.basis.parentOid });
      } else {
        review.status = 'delivering'; review.error = undefined;
        this.save(review, 'delivery.continued', 'Explicitly continuing the previously approved delivery.');
      }
      const plan = review.deliveryPlan;
      const state = reconcileGitDelivery(review.basis.root, review.basis.workspace, plan);
      if (!state.commitCreated) commitGitDelivery(review.basis.root, review.basis.workspace, plan);
      review.commitOid = plan.commitOid;
      this.save(review, 'delivery.committed', 'Approved commit is retained.', { commitOid: plan.commitOid });
      if (!state.merged) mergeGitDelivery(review.basis.root, review.basis.workspace, plan);
      review.merged = true;
      this.save(review, 'delivery.merged', 'Approved commit merged into the parent branch.', { commitOid: plan.commitOid, parentBranch: review.basis.parentBranch });
      review.cleaned = cleanupGitDelivery(review.basis.root, review.basis.workspace, plan).cleaned;
      review.status = 'delivered';
      this.save(review, 'delivery.completed', 'Local delivery completed. Push remains a separate action.', { commitOid: plan.commitOid, cleaned: review.cleaned });
      return review;
    } catch (error) {
      review.status = review.deliveryPlan ? 'interrupted' : this.get(review.id).status === 'stale' ? 'stale' : 'failed';
      review.error = errorText(error);
      this.save(review, 'delivery.failed', review.error);
      throw error;
    } finally { this.busy.delete(review.conversationId); this.changed(); }
  }
  async stop(id: string): Promise<void> {
    const state = this.checking.get(id);
    if (state) { state.controller.abort(); try { await state.done; } catch { /* Failure is recorded by runChecks. */ } }
  }
  async close(): Promise<void> {
    this.accepting = false;
    await Promise.all([...this.checking.keys()].map(id => this.stop(id)));
  }
}
