import { DelegationRecords } from './delegation-records.js';
import { reconstructLegacyNativeOwnership } from './native-legacy-ownership.js';
import type { NativeOperationRecords } from './native-operation-records.js';
import type { CapacityLease } from './session-capacity.js';
import type { Store } from './store.js';

/**
 * Startup reconstruction for one native admission owner. The two functions here run in order and
 * are kept separate so the owner installs each set of leases at exactly the point the single
 * constructor body did: quarantined capacity is restored before the legacy ownership transaction,
 * and that transaction still precedes the legacy capacity restore.
 */

/**
 * Reopen reconciliation: reopened operations, eligible setup cleanup and linked session
 * consistency, then the quarantined leases the owner restores.
 */
export function reconcileNativeAdmissionOnReopen(
  store: Store,
  records: NativeOperationRecords,
): CapacityLease[] {
  records.reconcileOnReopen();
  const sessions = new DelegationRecords(store);
  for (const run of store.runs())
    if (
      run.status === 'interrupted' &&
      run.cleanupUnconfirmed === false &&
      sessions
        .sessions(run.id)
        .some((session) => session.cleanupEvidence?.reconciliation === 'later-boot')
    )
      records.reconcileSetupCleanup(run.id);
  const operations = records.list();
  for (const operation of operations) {
    if (
      !operation.runId ||
      !operation.sessionId ||
      !['model-turn', 'command'].includes(operation.purpose) ||
      !operation.cleanupConfirmed ||
      !operation.cleanupEvidence
    )
      continue;
    const linked = operations.filter((item) => item.sessionId === operation.sessionId);
    if (
      linked.some(
        (item) =>
          !item.cleanupConfirmed ||
          item.runId !== operation.runId ||
          item.harness !== operation.harness,
      )
    )
      continue;
    const session = sessions
      .sessions(operation.runId)
      .find((item) => item.id === operation.sessionId);
    if (!session || session.harness !== operation.harness) continue;
    if (
      operation.state === 'interrupted' &&
      operation.cleanupEvidence.reason === 'not-admitted-on-reopen' &&
      session.native
    )
      throw new Error('Queued native operation contradicts a retained native session identity.');
    if (['prepared', 'dispatch-intent', 'running'].includes(session.state))
      sessions.finishSession({
        runId: operation.runId,
        sessionId: session.id,
        status: 'interrupted',
        cleanupConfirmed: true,
        cleanupEvidence: { operationId: operation.id, ...operation.cleanupEvidence },
        error: 'Native operation cleanup is retained. No session was resumed.',
      });
  }
  return records
    .list()
    .filter((item) => item.state === 'quarantined')
    .map((item) => ({
      reservationId: item.id,
      ownerId: item.owner.id,
      runId: item.runId,
      harness: item.harness,
      ...item.capacity,
      generation: 1,
      state: 'cleanup-unconfirmed' as const,
    }));
}

/**
 * Legacy ownership reconstruction. The native_legacy_ownership write stays inside
 * store.transaction and completes before the caller restores this capacity.
 */
export function retainedLegacyNativeLeases(store: Store): CapacityLease[] {
  const retained = (
    store.db.prepare('SELECT document FROM native_legacy_ownership').all() as Array<{
      document: string;
    }>
  ).map((row) => JSON.parse(row.document) as CapacityLease);
  const legacy = [
    ...new Map(
      [...reconstructLegacyNativeOwnership(store), ...retained].map((lease) => [
        lease.reservationId,
        lease,
      ]),
    ).values(),
  ];
  store.transaction(() => {
    for (const lease of legacy)
      store.db
        .prepare('INSERT OR IGNORE INTO native_legacy_ownership(id, document) VALUES (?, ?)')
        .run(lease.reservationId, JSON.stringify(lease));
  });
  return legacy;
}
