import { randomUUID } from 'node:crypto';
import { admittedHarnessAdapter } from './admitted-harness-adapter.js';
import { AdapterRunFailure, type HarnessAdapter, type HarnessId } from './contracts.js';
import { legacyNativeCleanupConfirmed } from './native-legacy-ownership.js';
import {
  reconcileNativeAdmissionOnReopen,
  retainedLegacyNativeLeases,
} from './native-admission-recovery.js';
import type { NativeAdmissionCleanup, NativeAdmissionContext } from './native-admission-types.js';
import { NativeAdmissionQueue } from './native-admission-queue.js';
import { NativeOperationRecords, type NativeOperation } from './native-operation-records.js';
import {
  SessionCapacity,
  type CapacityLease,
  type CapacityLimits,
  type CapacityQueueReason,
} from './session-capacity.js';
import { Store } from './store.js';

// The admission context and cleanup shapes live in native-admission-types.ts so the wrapper
// factory can import them without referring back to this module. These re-exports keep every
// established native-admission import intact.
export type { NativeAdmissionCleanup, NativeAdmissionContext } from './native-admission-types.js';
type Active = {
  purpose: NativeOperation['purpose'];
  runId?: string;
  controller: AbortController;
  done: Promise<unknown>;
};

/** One native admission owner. SQLite settlement precedes releasing any process capacity. */
export class NativeAdmission {
  readonly records: NativeOperationRecords;
  readonly queue: NativeAdmissionQueue;
  private accepting = true;
  private readonly legacy = new Map<string, CapacityLease>();
  private readonly active = new Map<string, Active>();
  private readonly waiting = new Map<string, CapacityQueueReason>();

  constructor(
    private readonly store: Store,
    private readonly origin: Record<string, unknown>,
    limits?: CapacityLimits,
    private readonly changed: () => void = () => {},
  ) {
    this.origin = structuredClone(origin);
    this.records = new NativeOperationRecords(store);
    this.queue = new NativeAdmissionQueue(new SessionCapacity(limits));
    this.queue.capacity.restore(reconcileNativeAdmissionOnReopen(store, this.records));
    const legacy = retainedLegacyNativeLeases(store);
    this.queue.capacity.restore(legacy);
    for (const lease of legacy) this.legacy.set(lease.reservationId, lease);
  }

  reconcileSetupCleanup(runId: string): void {
    this.records.reconcileSetupCleanup(runId);
    const ids = new Set(
      this.records
        .list({ runId })
        .filter((item) => item.cleanupConfirmed)
        .map((item) => item.id),
    );
    for (const lease of this.queue.capacity.snapshot().leases)
      if (ids.has(lease.reservationId)) this.queue.release(lease, true);
    this.reconcileLegacyCleanup();
  }

  reconcileLegacyCleanup(): void {
    if (!this.legacy.size) return;
    for (const [id, lease] of this.legacy)
      if (legacyNativeCleanupConfirmed(this.store, lease)) {
        this.store.db.prepare('DELETE FROM native_legacy_ownership WHERE id=?').run(id);
        this.legacy.delete(id);
        this.queue.release(lease, true);
      }
  }

  snapshot() {
    return {
      capacity: this.queue.capacity.snapshot(),
      waiting: [...this.waiting].map(([id, reason]) => ({ id, reason })),
      operations: this.records.list(),
    };
  }
  hasActiveWork(includeDiscovery = true): boolean {
    return [...this.active.values()].some(
      (item) =>
        includeDiscovery ||
        (item.purpose !== 'discovery' && item.purpose !== 'installation-discovery'),
    );
  }

  adapter(
    harness: HarnessId,
    adapter: HarnessAdapter,
    context: NativeAdmissionContext,
  ): HarnessAdapter {
    return admittedHarnessAdapter(
      harness,
      { ...context, owner: structuredClone(context.owner) },
      adapter,
      <T>(
        performHarness: HarnessId,
        performContext: NativeAdmissionContext,
        purpose: NativeOperation['purpose'],
        executable: string | undefined,
        signal: AbortSignal | undefined,
        invoke: (signal: AbortSignal) => Promise<T>,
        cleanup: (result: T) => NativeAdmissionCleanup,
      ) =>
        this.perform(performHarness, performContext, purpose, executable, signal, invoke, cleanup),
    );
  }

  perform<T>(
    harness: HarnessId,
    context: NativeAdmissionContext,
    purpose: NativeOperation['purpose'],
    executable: string | undefined,
    signal: AbortSignal | undefined,
    invoke: (signal: AbortSignal) => Promise<T>,
    cleanup: (result: T) => NativeAdmissionCleanup,
  ): Promise<T> {
    context = { ...context, owner: structuredClone(context.owner) };
    for (const value of [context.timeoutMs, context.cleanupTimeoutMs])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000))
        return Promise.reject(
          new AdapterRunFailure('Native operation deadline is invalid.', {
            dispatch: 'not-invoked',
          }),
        );
    if (!this.accepting)
      return Promise.reject(
        new AdapterRunFailure('Native admission is closed.', { dispatch: 'not-invoked' }),
      );
    this.reconcileLegacyCleanup();
    const id = randomUUID(),
      controller = new AbortController();
    const cancel = () => {
      controller.abort();
      this.queue.drain();
    };
    const intent = this.records.create({
      id,
      owner: context.owner,
      runId: context.runId,
      sessionId: context.sessionId,
      reviewId: context.reviewId,
      checkId: context.checkId,
      harness,
      purpose,
      requestedExecutable: executable,
      generation: context.generation ?? 1,
      origin: this.origin,
      capacity: {
        role:
          context.role ??
          (purpose === 'model-turn' ? 'main' : purpose === 'command' ? 'command' : 'discovery'),
        authorizationId: context.authorizationId,
        workerParallelLimit: context.workerParallelLimit,
      },
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const assertCurrent = () => {
      if (!this.accepting || controller.signal.aborted)
        throw new AdapterRunFailure('Native operation cancelled before dispatch.', {
          dispatch: 'not-invoked',
        });
      const checked: unknown = context.assertCurrent?.();
      if (checked && typeof (checked as { then?: unknown }).then === 'function') {
        void (async () => {
          try {
            await checked;
          } catch {
            /* Rejected asynchronous guards remain unauthorized. */
          }
        })();
        throw new Error('Native admission authority guards must be synchronous.');
      }
    };
    // Publish the lifecycle promise before queue callbacks can synchronously cancel this operation.
    let resolveDone: (value: unknown) => void, rejectDone: (reason?: unknown) => void;
    const done = new Promise<unknown>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const active: Active = { purpose, runId: context.runId, controller, done };
    this.active.set(id, active);
    const lifecycle = (async () => {
      let lease: CapacityLease | undefined,
        invoked = false,
        admitted = false,
        settlementAttempted = false,
        settled = false;
      let operationTimer: ReturnType<typeof setTimeout> | undefined,
        cleanupTimer: ReturnType<typeof setTimeout> | undefined,
        timedOut = false;
      let abandon: (() => void) | undefined;
      const cancelled = () => {
        if (invoked && !cleanupTimer)
          cleanupTimer = setTimeout(() => abandon?.(), context.cleanupTimeoutMs ?? 5_000);
      };
      controller.signal.addEventListener('abort', cancelled, { once: true });
      const settle = (result: NativeAdmissionCleanup) => {
        settlementAttempted = true;
        if (!admitted)
          this.records.cancelQueued({
            id,
            expectedGeneration: intent.generation,
            cleanupEvidence: result.evidence,
          });
        else
          this.records.settle({
            id,
            expectedGeneration: intent.generation,
            status: result.status,
            cleanupConfirmed: result.confirmed,
            cleanupEvidence: result.evidence,
          });
        settled = true;
        if (lease) {
          this.queue.release(lease, result.confirmed);
          lease = undefined;
        }
      };
      try {
        lease = await this.queue.acquire({
          reservation: {
            reservationId: id,
            ownerId: context.owner.id,
            runId: context.runId,
            harness,
            ...intent.capacity,
          },
          priority: context.priority ?? (() => 0),
          assertCurrent,
          queued: (reason) => {
            this.waiting.set(id, reason);
            context.queued?.(reason);
            this.changed();
          },
        });
        this.waiting.delete(id);
        assertCurrent();
        this.records.admit({ id, expectedGeneration: intent.generation });
        admitted = true;
        assertCurrent();
        const admittedCallback: unknown = context.onAdmitted?.();
        if (
          admittedCallback &&
          typeof (admittedCallback as { then?: unknown }).then === 'function'
        ) {
          void (async () => {
            try {
              await admittedCallback;
            } catch {
              /* Asynchronous admission callbacks cannot authorize dispatch. */
            }
          })();
          throw new Error('Native admission callbacks must be synchronous.');
        }
        assertCurrent();
        invoked = true;
        const abandoned = new Promise<never>((_resolve, reject) => {
          abandon = () =>
            reject(new Error('Native operation did not confirm cleanup after cancellation.'));
        });
        const timeoutMs =
          context.timeoutMs ??
          (purpose === 'command' || purpose === 'discovery' ? 600_000 : undefined);
        if (timeoutMs !== undefined)
          operationTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
        // Only this continuation can settle the record. Late raw results remain observed by
        // Promise.race, but cannot resolve identities, publish cleanup, or release quarantine.
        const result = await Promise.race([invoke(controller.signal), abandoned]);
        const evidence = cleanup(result);
        if (timedOut || (purpose === 'discovery' && controller.signal.aborted))
          evidence.status = 'interrupted';
        if (evidence.identity)
          this.records.resolveIdentity({
            id,
            expectedGeneration: intent.generation,
            resolvedIdentity: evidence.identity,
          });
        settle(evidence);
        if (timedOut) {
          if (evidence.confirmed)
            throw new AdapterRunFailure(
              'Native operation exceeded its execution deadline.',
              evidence.evidence,
            );
          throw new Error(
            'Native operation exceeded its execution deadline; cleanup could not be confirmed.',
          );
        }
        if (purpose === 'discovery' && controller.signal.aborted) {
          if (evidence.confirmed)
            throw new AdapterRunFailure('Discovery was cancelled.', evidence.evidence);
          throw new Error('Discovery was cancelled; native cleanup could not be confirmed.');
        }
        return result;
      } catch (error) {
        if (settlementAttempted && !settled) {
          if (lease) {
            this.queue.release(lease, false);
            lease = undefined;
          }
          throw error;
        }
        if (!settled) {
          const confirmed = !invoked || error instanceof AdapterRunFailure;
          try {
            settle({
              status: controller.signal.aborted ? 'interrupted' : 'failed',
              confirmed,
              evidence: !invoked
                ? { dispatch: 'not-invoked' }
                : error instanceof AdapterRunFailure
                  ? error.cleanupEvidence
                  : { reason: 'adapter-failure-without-cleanup-evidence' },
            });
          } catch (persistenceError) {
            // Durable admission remains occupied on reopen; never release on failed settlement.
            if (lease) {
              this.queue.release(lease, false);
              lease = undefined;
            }
            throw persistenceError;
          }
        }
        if (!invoked && !(error instanceof AdapterRunFailure))
          throw new AdapterRunFailure(
            error instanceof Error ? error.message : 'Native admission failed.',
            { dispatch: 'not-invoked' },
          );
        throw error;
      } finally {
        clearTimeout(operationTimer);
        clearTimeout(cleanupTimer);
        controller.signal.removeEventListener('abort', cancelled);
        signal?.removeEventListener('abort', cancel);
        this.active.delete(id);
        this.waiting.delete(id);
        this.changed();
      }
    })();
    void (async () => {
      try {
        resolveDone!(await lifecycle);
      } catch (error) {
        rejectDone!(error);
      }
    })();
    this.changed();
    return active.done as Promise<T>;
  }

  private async stop(active: Active[]): Promise<void> {
    for (const item of active) item.controller.abort();
    this.queue.drain();
    await Promise.allSettled(active.map((item) => item.done));
  }
  async stopRun(runId: string): Promise<void> {
    if (
      typeof runId !== 'string' ||
      !runId.trim() ||
      runId.trim() !== runId ||
      runId.length > 1_000
    )
      throw new Error('Native admission run ID is invalid.');
    await this.stop([...this.active.values()].filter((item) => item.runId === runId));
  }
  async stopAll(): Promise<void> {
    await this.stop([...this.active.values()]);
  }
  async close(): Promise<void> {
    this.accepting = false;
    await this.stopAll();
  }
}
