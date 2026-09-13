import { randomUUID } from 'node:crypto';
import { AdapterRunFailure, type HarnessAdapter, type HarnessId } from './contracts.js';
import { legacyNativeCleanupConfirmed, reconstructLegacyNativeOwnership } from './native-legacy-ownership.js';
import { DelegationRecords } from './delegation-records.js';
import { NativeAdmissionQueue } from './native-admission-queue.js';
import { NativeOperationRecords, type NativeOperation, type NativeOperationOwner } from './native-operation-records.js';
import { SessionCapacity, type CapacityLease, type CapacityLimits, type CapacityQueueReason, type NativeSessionRole } from './session-capacity.js';
import { Store } from './store.js';

export type NativeAdmissionContext = { owner: NativeOperationOwner; runId?: string; sessionId?: string; reviewId?: string; checkId?: string; generation?: number; role?: NativeSessionRole; authorizationId?: string; workerParallelLimit?: number; priority?: () => number; assertCurrent?: () => void; onAdmitted?: () => void; queued?: (reason: CapacityQueueReason) => void; timeoutMs?: number; cleanupTimeoutMs?: number };
export type NativeAdmissionCleanup = { status: 'completed' | 'failed' | 'interrupted'; confirmed: boolean; evidence: Record<string, unknown>; identity?: { executable: string; version: string } };
type Active = { purpose: NativeOperation['purpose']; controller: AbortController; done: Promise<unknown> };

/** One native admission owner. SQLite settlement precedes releasing any process capacity. */
export class NativeAdmission {
  readonly records: NativeOperationRecords;
  readonly queue: NativeAdmissionQueue;
  private accepting = true;
  private readonly legacy = new Map<string, CapacityLease>();
  private readonly active = new Map<string, Active>();
  private readonly waiting = new Map<string, CapacityQueueReason>();

  constructor(private readonly store: Store, private readonly origin: Record<string, unknown>, limits?: CapacityLimits, private readonly changed: () => void = () => {}) {
    this.origin = structuredClone(origin);
    this.records = new NativeOperationRecords(store);
    this.queue = new NativeAdmissionQueue(new SessionCapacity(limits));
    this.records.reconcileOnReopen();
    const sessions = new DelegationRecords(store);
    for (const run of store.runs()) if (run.status === 'interrupted' && run.cleanupUnconfirmed === false && sessions.sessions(run.id).some(session => session.cleanupEvidence?.reconciliation === 'later-boot')) this.records.reconcileSetupCleanup(run.id);
    const operations = this.records.list();
    for (const operation of operations) {
      if (!operation.runId || !operation.sessionId || !['model-turn', 'command'].includes(operation.purpose) || !operation.cleanupConfirmed || !operation.cleanupEvidence) continue;
      const linked = operations.filter(item => item.sessionId === operation.sessionId);
      if (linked.some(item => !item.cleanupConfirmed || item.runId !== operation.runId || item.harness !== operation.harness)) continue;
      const session = sessions.sessions(operation.runId).find(item => item.id === operation.sessionId);
      if (!session || session.harness !== operation.harness) continue;
      if (operation.state === 'interrupted' && operation.cleanupEvidence.reason === 'not-admitted-on-reopen' && session.native) throw new Error('Queued native operation contradicts a retained native session identity.');
      if (['prepared', 'dispatch-intent', 'running'].includes(session.state)) sessions.finishSession({ runId: operation.runId, sessionId: session.id, status: 'interrupted', cleanupConfirmed: true, cleanupEvidence: { operationId: operation.id, ...operation.cleanupEvidence }, error: 'Native operation cleanup is retained. No session was resumed.' });
    }
    this.queue.capacity.restore(this.records.list().filter(item => item.state === 'quarantined').map(item => ({
      reservationId: item.id, ownerId: item.owner.id, runId: item.runId, harness: item.harness,
      ...item.capacity, generation: 1, state: 'cleanup-unconfirmed' as const,
    })));
    const retained = (store.db.prepare('SELECT document FROM native_legacy_ownership').all() as Array<{ document: string }>).map(row => JSON.parse(row.document) as CapacityLease);
    const legacy = [...new Map([...reconstructLegacyNativeOwnership(store), ...retained].map(lease => [lease.reservationId, lease])).values()];
    store.transaction(() => { for (const lease of legacy) store.db.prepare('INSERT OR IGNORE INTO native_legacy_ownership(id, document) VALUES (?, ?)').run(lease.reservationId, JSON.stringify(lease)); });
    this.queue.capacity.restore(legacy);
    for (const lease of legacy) this.legacy.set(lease.reservationId, lease);
  }

  reconcileSetupCleanup(runId: string): void {
    this.records.reconcileSetupCleanup(runId);
    const ids = new Set(this.records.list({ runId }).filter(item => item.cleanupConfirmed).map(item => item.id));
    for (const lease of this.queue.capacity.snapshot().leases) if (ids.has(lease.reservationId)) this.queue.release(lease, true);
    this.reconcileLegacyCleanup();
  }

  reconcileLegacyCleanup(): void {
    if (!this.legacy.size) return;
    for (const [id, lease] of this.legacy) if (legacyNativeCleanupConfirmed(this.store, lease)) {
      this.store.db.prepare('DELETE FROM native_legacy_ownership WHERE id=?').run(id);
      this.legacy.delete(id); this.queue.release(lease, true);
    }
  }

  snapshot() { return { capacity: this.queue.capacity.snapshot(), waiting: [...this.waiting].map(([id, reason]) => ({ id, reason })), operations: this.records.list() }; }
  hasActiveWork(includeDiscovery = true): boolean { return [...this.active.values()].some(item => includeDiscovery || item.purpose !== 'discovery' && item.purpose !== 'installation-discovery'); }

  adapter(harness: HarnessId, adapter: HarnessAdapter, context: NativeAdmissionContext): HarnessAdapter {
    context = { ...context, owner: structuredClone(context.owner) };
    return {
      // Inventory is filesystem-only. Every native probe must use discover.
      ...(adapter.installations ? { installations: () => adapter.installations!() } : {}),
      discover: (executable, signal) => this.perform(harness, context, 'discovery', executable, signal,
        async ownedSignal => {
          const info = await adapter.discover(executable, ownedSignal);
          return info.cleanupVerified === true ? info : { ...info, available: false, authenticated: false, models: [], executionModes: [], reason: 'Native discovery cleanup could not be confirmed.' };
        },
        info => ({ status: info.available ? 'completed' : 'failed', confirmed: info.cleanupVerified === true, evidence: { adapterCleanupVerified: info.cleanupVerified === true }, ...(info.executable && info.version ? { identity: { executable: info.executable, version: info.version } } : {}) })),
      run: async value => {
        const input = { ...value, messages: structuredClone(value.messages), workspaceIdentity: value.workspaceIdentity ? structuredClone(value.workspaceIdentity) : undefined, ...(value.applicationTools ? { applicationTools: { definitions: structuredClone(value.applicationTools.definitions), onRequest: value.applicationTools.onRequest } } : {}) };
        let accepting = true;
        try { return await this.perform(harness, context, 'model-turn', input.executable, input.signal,
          signal => adapter.run({ ...input, signal, onEvent: event => { if (accepting) input.onEvent(event); }, ...(input.applicationTools ? { applicationTools: { ...input.applicationTools, onRequest: request => { if (!accepting || signal.aborted) throw new Error('Native application tool request arrived after cancellation or settlement.'); return input.applicationTools!.onRequest(request); } } } : {}) }),
          result => ({ status: result.status === 'stop-unconfirmed' ? 'failed' : result.status, confirmed: result.status !== 'stop-unconfirmed', evidence: { adapterStatus: result.status } }));
        } finally { accepting = false; }
      },
      ...(adapter.runCommand ? { runCommand: async (value: Parameters<NonNullable<HarnessAdapter['runCommand']>>[0]) => {
        const input = { ...value, command: [...value.command], workspaceIdentity: value.workspaceIdentity ? structuredClone(value.workspaceIdentity) : undefined };
        let accepting = true;
        try { return await this.perform(harness, context, 'command', input.executable, input.signal,
          signal => adapter.runCommand!({ ...input, signal, onDispatch: value => { if (!accepting || signal.aborted) throw new Error('Native command dispatch arrived after cancellation or settlement.'); const checked: unknown = input.onDispatch?.(value); if (checked && typeof (checked as { then?: unknown }).then === 'function') { void (async () => { try { await checked; } catch { /* Rejected asynchronous dispatch callbacks remain unauthorized. */ } })(); throw new Error('Native command dispatch callbacks must be synchronous.'); } }, onOutput: value => { if (accepting) input.onOutput(value); } }),
          result => ({ status: result.exitCode === 0 ? 'completed' : 'failed', confirmed: result.cleanupVerified === true, evidence: { adapterCleanupVerified: result.cleanupVerified === true, exitCode: result.exitCode } }));
        } finally { accepting = false; }
      } } : {}),
    };
  }

  perform<T>(harness: HarnessId, context: NativeAdmissionContext, purpose: NativeOperation['purpose'], executable: string | undefined, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>, cleanup: (result: T) => NativeAdmissionCleanup): Promise<T> {
    context = { ...context, owner: structuredClone(context.owner) };
    for (const value of [context.timeoutMs, context.cleanupTimeoutMs]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) return Promise.reject(new AdapterRunFailure('Native operation deadline is invalid.', { dispatch: 'not-invoked' }));
    if (!this.accepting) return Promise.reject(new AdapterRunFailure('Native admission is closed.', { dispatch: 'not-invoked' }));
    this.reconcileLegacyCleanup();
    const id = randomUUID(), controller = new AbortController();
    const cancel = () => { controller.abort(); this.queue.drain(); };
    const intent = this.records.create({ id, owner: context.owner, runId: context.runId, sessionId: context.sessionId, reviewId: context.reviewId, checkId: context.checkId, harness, purpose, requestedExecutable: executable, generation: context.generation ?? 1, origin: this.origin,
      capacity: { role: context.role ?? (purpose === 'model-turn' ? 'main' : purpose === 'command' ? 'command' : 'discovery'), authorizationId: context.authorizationId, workerParallelLimit: context.workerParallelLimit } });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const assertCurrent = () => {
      if (!this.accepting || controller.signal.aborted) throw new AdapterRunFailure('Native operation cancelled before dispatch.', { dispatch: 'not-invoked' });
      const checked: unknown = context.assertCurrent?.();
      if (checked && typeof (checked as { then?: unknown }).then === 'function') {
        void (async () => { try { await checked; } catch { /* Rejected asynchronous guards remain unauthorized. */ } })();
        throw new Error('Native admission authority guards must be synchronous.');
      }
    };
    // Register before the first asynchronous continuation, including immediate queue admission.
    const active: Active = { purpose, controller, done: Promise.resolve() };
    this.active.set(id, active);
    active.done = (async () => {
      let lease: CapacityLease | undefined, invoked = false, admitted = false, settlementAttempted = false, settled = false;
      let operationTimer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
      let abandon: (() => void) | undefined;
      const cancelled = () => { if (invoked && !cleanupTimer) cleanupTimer = setTimeout(() => abandon?.(), context.cleanupTimeoutMs ?? 5_000); };
      controller.signal.addEventListener('abort', cancelled, { once: true });
      const settle = (result: NativeAdmissionCleanup) => {
        settlementAttempted = true;
        if (!admitted) this.records.cancelQueued({ id, expectedGeneration: intent.generation, cleanupEvidence: result.evidence });
        else this.records.settle({ id, expectedGeneration: intent.generation, status: result.status, cleanupConfirmed: result.confirmed, cleanupEvidence: result.evidence });
        settled = true;
        if (lease) { this.queue.release(lease, result.confirmed); lease = undefined; }
      };
      try {
        lease = await this.queue.acquire({ reservation: { reservationId: id, ownerId: context.owner.id, runId: context.runId, harness, ...intent.capacity }, priority: context.priority ?? (() => 0), assertCurrent, queued: reason => { this.waiting.set(id, reason); context.queued?.(reason); this.changed(); } });
        this.waiting.delete(id);
        assertCurrent();
        this.records.admit({ id, expectedGeneration: intent.generation });
        admitted = true;
        assertCurrent();
        const admittedCallback: unknown = context.onAdmitted?.();
        if (admittedCallback && typeof (admittedCallback as { then?: unknown }).then === 'function') {
          void (async () => { try { await admittedCallback; } catch { /* Asynchronous admission callbacks cannot authorize dispatch. */ } })();
          throw new Error('Native admission callbacks must be synchronous.');
        }
        assertCurrent();
        invoked = true;
        const abandoned = new Promise<never>((_resolve, reject) => { abandon = () => reject(new Error('Native operation did not confirm cleanup after cancellation.')); });
        const timeoutMs = context.timeoutMs ?? (purpose === 'command' || purpose === 'discovery' ? 600_000 : undefined);
        if (timeoutMs !== undefined) operationTimer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        // Only this continuation can settle the record. Late raw results remain observed by
        // Promise.race, but cannot resolve identities, publish cleanup, or release quarantine.
        const result = await Promise.race([invoke(controller.signal), abandoned]);
        const evidence = cleanup(result);
        if (timedOut || purpose === 'discovery' && controller.signal.aborted) evidence.status = 'interrupted';
        if (evidence.identity) this.records.resolveIdentity({ id, expectedGeneration: intent.generation, resolvedIdentity: evidence.identity });
        settle(evidence);
        if (timedOut) {
          if (evidence.confirmed) throw new AdapterRunFailure('Native operation exceeded its execution deadline.', evidence.evidence);
          throw new Error('Native operation exceeded its execution deadline; cleanup could not be confirmed.');
        }
        if (purpose === 'discovery' && controller.signal.aborted) {
          if (evidence.confirmed) throw new AdapterRunFailure('Discovery was cancelled.', evidence.evidence);
          throw new Error('Discovery was cancelled; native cleanup could not be confirmed.');
        }
        return result;
      } catch (error) {
        if (settlementAttempted && !settled) {
          if (lease) { this.queue.release(lease, false); lease = undefined; }
          throw error;
        }
        if (!settled) {
          const confirmed = !invoked || error instanceof AdapterRunFailure;
          try { settle({ status: controller.signal.aborted ? 'interrupted' : 'failed', confirmed, evidence: !invoked ? { dispatch: 'not-invoked' } : error instanceof AdapterRunFailure ? error.cleanupEvidence : { reason: 'adapter-failure-without-cleanup-evidence' } }); }
          catch (persistenceError) {
            // Durable admission remains occupied on reopen; never release on failed settlement.
            if (lease) { this.queue.release(lease, false); lease = undefined; }
            throw persistenceError;
          }
        }
        if (!invoked && !(error instanceof AdapterRunFailure)) throw new AdapterRunFailure(error instanceof Error ? error.message : 'Native admission failed.', { dispatch: 'not-invoked' });
        throw error;
      } finally {
        clearTimeout(operationTimer); clearTimeout(cleanupTimer); controller.signal.removeEventListener('abort', cancelled);
        signal?.removeEventListener('abort', cancel);
        this.active.delete(id); this.waiting.delete(id); this.changed();
      }
    })();
    this.changed();
    return active.done as Promise<T>;
  }

  async stopAll(): Promise<void> {
    const active = [...this.active.values()];
    for (const item of active) item.controller.abort();
    this.queue.drain();
    await Promise.allSettled(active.map(item => item.done));
  }
  async close(): Promise<void> { this.accepting = false; await this.stopAll(); }
}
