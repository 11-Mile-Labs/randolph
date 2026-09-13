import type { Run } from './contracts.js';
import { DelegationRecords } from './delegation-records.js';
import { Store } from './store.js';
import type { CapacityLease, CapacityHarness, NativeSessionRole } from './session-capacity.js';

type NativeReference = { runId?: string; sessionId?: string; reviewId?: string; checkId?: string; state: string; purpose?: string };
const harness = (value: unknown): CapacityHarness => { if (value === 'codex' || value === 'grok') return value; throw new Error('Legacy native ownership has an unknown harness.'); };
const lease = (reservationId: string, runId: string | undefined, role: NativeSessionRole, value: unknown): CapacityLease => ({ reservationId, ...(runId ? { runId } : {}), ownerId: reservationId, harness: harness((value as { harness?: unknown })?.harness), role, generation: 1, state: 'cleanup-unconfirmed' });

/** Read-only conservative bridge for native work created before schema-5 operation receipts. */
export function reconstructLegacyNativeOwnership(store: Store, options: { ignoreOperationCoverage?: boolean } = {}): CapacityLease[] {
  const operations = (store.db.prepare('SELECT document FROM native_operations').all() as Array<{ document: string }>).map(row => JSON.parse(row.document) as NativeReference);
  const covered = (key: keyof NativeReference, value: string) => !options.ignoreOperationCoverage && operations.some(item => item[key] === value && (key !== 'sessionId' || item.purpose === 'model-turn' || item.purpose === 'command'));
  const result: CapacityLease[] = [], records = new DelegationRecords(store);
  for (const run of store.runs()) {
    const allSessions = records.sessions(run.id);
    const sessions = allSessions.filter(session => !covered('sessionId', session.id) && (['dispatch-intent', 'running', 'cleanup-unconfirmed'].includes(session.state) || session.cleanupConfirmed === false));
    for (const session of sessions) result.push(lease(`legacy:session:${session.id}`, run.id, session.role === 'verification' ? 'runtime-verification' : 'main', session));
    const knownClean = allSessions.length > 0 && sessions.length === 0;
    if (!sessions.length && !knownClean && legacyRun(run)) result.push(lease(`legacy:run:${run.id}`, run.id, 'main', { harness: run.harness ?? 'codex' }));
  }
  for (const review of store.reviews()) {
    const commandOperations = options.ignoreOperationCoverage ? [] : operations.filter(item => item.reviewId === review.id && item.purpose === 'command');
    const checks = review.verification?.checks ?? [];
    const uncertain = review.status === 'checking' || review.status === 'stop-unconfirmed' || review.originOperation === 'cleanup-unconfirmed';
    if (!uncertain) continue;
    const run = store.runs().find(item => item.id === review.runId);
    const owner = { harness: run?.harness ?? 'codex' };
    if (checks.length) {
      const unknown = checks.filter(check => !check.cleanupVerified && !commandOperations.some(item => item.checkId === check.command.id));
      for (const check of unknown) result.push(lease(`legacy:review-check:${review.id}:${check.command.id}`, review.runId, 'command', owner));
      if (!unknown.length && review.status === 'checking' && !commandOperations.length) result.push(lease(`legacy:review:${review.id}`, review.runId, 'command', owner));
    } else if (!commandOperations.length) result.push(lease(`legacy:review:${review.id}`, review.runId, 'command', owner));
  }
  return result.sort((left, right) => left.reservationId.localeCompare(right.reservationId));
}
function legacyRun(run: Run): boolean { return run.cleanupUnconfirmed === true || ['starting', 'running', 'stopping', 'stop-unconfirmed'].includes(run.status) || run.status === 'interrupted' && run.cleanupUnconfirmed !== false; }

/** New operation coverage or a missing owner is never cleanup evidence for an older lease. */
export function legacyNativeCleanupConfirmed(store: Store, lease: CapacityLease): boolean {
  if (!lease.runId) return false;
  const run = store.runs().find(item => item.id === lease.runId);
  if (!run) return false;
  if (lease.reservationId.startsWith('legacy:session:')) {
    const session = new DelegationRecords(store).sessions(run.id).find(item => `legacy:session:${item.id}` === lease.reservationId);
    return Boolean(session?.cleanupConfirmed === true && ['completed', 'failed', 'interrupted'].includes(session.state));
  }
  if (lease.reservationId === `legacy:run:${run.id}`) return run.cleanupUnconfirmed === false && ['completed', 'failed', 'interrupted'].includes(run.status);
  for (const review of store.reviews().filter(item => item.runId === run.id)) {
    if (lease.reservationId === `legacy:review:${review.id}`) return !['checking', 'stop-unconfirmed'].includes(review.status) && Boolean(review.verification?.checks.length) && review.verification!.checks.every(check => check.cleanupVerified);
    const check = review.verification?.checks.find(item => `legacy:review-check:${review.id}:${item.command.id}` === lease.reservationId);
    if (check) return check.cleanupVerified === true;
  }
  return false;
}
