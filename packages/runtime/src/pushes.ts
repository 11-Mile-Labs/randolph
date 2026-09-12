import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReviewRecord } from './contracts.js';
import type { Store } from './store.js';
import { CleanupUnconfirmedError, previewOriginPush, executeOriginPush, reconcileOriginPush, type PushPlan, type PushState, type PushOptions } from './push.js';
export type PushRecord = { revision: string; plan: PushPlan; status: 'preview' | 'pushing' | 'pushed' | 'stale' | 'uncertain'; approvedAt?: string; result?: PushState; error?: string };
export type ApprovePushInput = { reviewId: string; revision: string };
type PushOperations = { preview: typeof previewOriginPush; execute: typeof executeOriginPush; reconcile: typeof reconcileOriginPush };
export class Pushes {
  private readonly active = new Map<string, { conversationId: string; controller: AbortController; done: Promise<ReviewRecord> }>();
  private accepting = true;
  constructor(private readonly store: Store, private readonly canWork: (id: string) => boolean, private readonly changed: () => void, private readonly options: PushOptions = { sshKeyPath: join(homedir(), '.ssh', 'id_ed25519') }, private readonly operations: PushOperations = { preview: previewOriginPush, execute: executeOriginPush, reconcile: reconcileOriginPush }) {
    for (const review of store.reviews()) if (review.originOperation === 'active' || review.push?.status === 'pushing') {
      if (review.push) {
        review.push.result = { status: 'uncertain', localOid: review.push.plan.localOid, remoteOid: null, cleanupVerified: false };
        review.push.status = 'uncertain'; review.push.error = 'The app ended during an origin operation. Process cleanup could not be confirmed.';
      }
      this.quarantine(review);
    }
  }
  private quarantine(review: ReviewRecord): void {
    review.originOperation = 'cleanup-unconfirmed';
    const run = this.store.runs().find(item => item.id === review.runId)!;
    run.cleanupUnconfirmed = true;
    run.error = 'Origin operation cleanup could not be confirmed. Further work is blocked in this conversation.';
    this.store.transaction(() => { this.store.putRun(run); this.store.putReview(review); this.store.append(run, 'push.cleanup-unconfirmed', run.error!); });
    try { this.store.exportRun(run); } catch { /* SQLite keeps the quarantine; projection is repaired on reopen. */ }
    this.changed();
  }

  hasActiveWork(conversationId?: string): boolean {
    return [...this.active.values()].some(state => !conversationId || state.conversationId === conversationId)
      || Boolean(conversationId && this.store.reviews().some(review => review.conversationId === conversationId && (review.originOperation === 'cleanup-unconfirmed' || review.push?.result?.cleanupVerified === false)));
  }
  private get(id: string): ReviewRecord {
    const review = this.store.reviews().find(item => item.id === id);
    if (!review || review.status !== 'delivered' || !review.merged || !review.cleaned) throw new Error('Complete local delivery before requesting push.');
    return review;
  }
  private save(review: ReviewRecord, event: string): void {
    const run = this.store.runs().find(item => item.id === review.runId)!;
    review.updatedAt = new Date().toISOString();
    this.store.transaction(() => { this.store.putReview(review); this.store.append(run, event, review.push?.error ?? `Origin push ${review.push?.status}`, { push: review.push }); });
    this.store.exportRun(run); this.changed();
  }
  private async operation(id: string, action: (review: ReviewRecord, options: PushOptions) => Promise<ReviewRecord>): Promise<ReviewRecord> {
    const review = this.get(id);
    if (!this.accepting || !this.canWork(review.conversationId) || this.hasActiveWork(review.conversationId)) throw new Error('Wait for active work or unconfirmed cleanup before an origin operation.');
    review.originOperation = 'active';
    try { this.save(review, 'push.operation-started'); }
    catch (error) { review.originOperation = undefined; this.store.putReview(review); throw error; }
    const controller = new AbortController();
    const state = { conversationId: review.conversationId, controller, done: Promise.resolve(review) };
    this.active.set(id, state);
    const done = action(review, { ...this.options, signal: controller.signal }); state.done = done; this.changed();
    try {
      const result = await done;
      if (result.push?.result?.cleanupVerified === false) this.quarantine(review);
      return result;
    } catch (error) {
      if (error instanceof CleanupUnconfirmedError) this.quarantine(review);
      throw error;
    } finally {
      this.active.delete(id);
      if (review.originOperation === 'active') {
        review.originOperation = undefined;
        this.save(review, 'push.operation-finished');
      }
      this.changed();
    }
  }

  preview(id: string): Promise<ReviewRecord> {
    return this.operation(id, async (review, options) => {
      if (review.push?.approvedAt && review.push.status !== 'stale') throw new Error('Recheck the approved push outcome before replacing its preview.');
      const plan = await this.operations.preview(review.basis.root, options);
      if (plan.localOid !== review.commitOid) throw new Error('The parent has additional commits since delivery. Start a fresh delivery review before pushing this result.');
      review.push = { revision: createHash('sha256').update(JSON.stringify(plan)).digest('hex'), plan, status: 'preview' };
      this.save(review, 'push.previewed'); return review;
    });
  }
  approve(input: ApprovePushInput): Promise<ReviewRecord> {
    return this.operation(input.reviewId, async (review, options) => {
      if (!review.push || review.push.revision !== input.revision) throw new Error('Push preview changed. Inspect and approve the current preview.');
      if (review.push.status === 'pushed') return review;
      if (review.push.status !== 'preview') throw new Error('Recheck the push outcome and prepare a fresh preview before approving.');
      review.push.status = 'pushing'; review.push.approvedAt = new Date().toISOString();
      this.save(review, 'push.approved');
      const result = await this.operations.execute(review.push.plan, options);
      review.push.result = result;
      review.push.status = result.status === 'pushed' ? 'pushed' : result.status === 'uncertain' ? 'uncertain' : 'stale';
      review.push.error = result.error;
      this.save(review, 'push.completed'); return review;
    });
  }
  check(id: string): Promise<ReviewRecord> {
    return this.operation(id, async (review, options) => {
      if (!review.push) throw new Error('There is no retained push to reconcile.');
      const result = await this.operations.reconcile(review.push.plan, options);
      review.push.result = result;
      review.push.status = result.status === 'pushed' ? 'pushed' : result.status === 'uncertain' ? 'uncertain' : 'stale';
      review.push.error = result.error;
      this.save(review, 'push.reconciled'); return review;
    });
  }
  async stop(id: string): Promise<void> { const state = this.active.get(id); if (state) { state.controller.abort(); try { await state.done; } catch { /* Durable intent supports explicit reconciliation. */ } } }
  async close(): Promise<void> { this.accepting = false; await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
  async stopAll(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
}
