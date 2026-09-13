import { createHash } from 'node:crypto';
import type { ReviewRecord, Run } from './contracts.js';
import { DelegationRecords, type DelegationAttempt } from './delegation-records.js';
import { Store } from './store.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceProvenance } from './workspace-leases.js';

type RetainedOwnership = { reservationId: string; state: 'active' | 'cleanup-unconfirmed' | 'released'; workspace: string; provenance?: WorkspaceProvenance };
type Witness = { kind: string; id: string; run: Run; workspace: string; phase: string; evidence: Record<string, unknown>; main?: boolean };
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const uncertainRun = (run: Run): boolean => Boolean(run.cleanupUnconfirmed) || ['starting', 'running', 'stopping', 'stop-unconfirmed'].includes(run.status);
const operationReceipt = (store: Store): RetainedOwnership[] => (store.db.prepare('SELECT document FROM workspace_ownership ORDER BY rowid').all() as Array<{ document: string }>).map(row => JSON.parse(row.document) as RetainedOwnership);
const reservationId = (witness: Witness): string => `legacy-workspace-${digest(`${witness.kind}\u0000${witness.id}\u0000${witness.workspace}`)}`;
// A deterministic legacy witness must never be recreated after either a second boot
// or a terminal release. For main runs, a concrete existing run provenance is also
// exact because one run has one native operation. Later review/push operations have
// no retained attempt ID in old data, so only an active/quarantined exact claim can
// suppress their witness; a clean historical receipt remains ambiguous.
const hasExactReceipt = (rows: RetainedOwnership[], witness: Witness): boolean => rows.some(row =>
  row.reservationId === reservationId(witness)
  || row.workspace === witness.workspace && row.provenance?.kind === witness.kind && row.provenance.id === witness.id
    && (witness.main || row.state !== 'released'));
const add = (items: Witness[], value: Witness): void => {
  if (!value.workspace || !value.workspace.startsWith('/')) return;
  if (!items.some(item => item.kind === value.kind && item.id === value.id && item.workspace === value.workspace)) items.push(value);
};
const reviewWitnesses = (review: ReviewRecord, run: Run, items: Witness[]): void => {
  const base = { run, evidence: { reconciliation: 'legacy-workspace-operation', reviewId: review.id } };
  if (review.status === 'checking' || review.status === 'stop-unconfirmed' || review.verification?.checks.some(check => !check.cleanupVerified)) add(items, { ...base, kind: 'verification', id: review.id, workspace: review.basis.workspace, phase: 'native-check' });
  if (review.status === 'delivering') {
    add(items, { ...base, kind: 'delivery', id: review.id, workspace: review.basis.workspace, phase: 'delivery' });
    add(items, { ...base, kind: 'delivery', id: review.id, workspace: review.basis.root, phase: 'delivery' });
  }
  if (review.originOperation === 'active' || review.originOperation === 'cleanup-unconfirmed' || review.push?.status === 'pushing' || review.push?.result?.cleanupVerified === false) add(items, { ...base, kind: 'push', id: review.id, workspace: review.basis.root, phase: 'native-push' });
};
const attemptWitnesses = (run: Run, attempt: DelegationAttempt, items: Witness[]): void => {
  const workspace = attempt.workspace?.path ?? attempt.preparation?.workspace?.path;
  if (!workspace) return;
  const uncertainPreparation = attempt.runtimeRecoveryRequired || attempt.preparation?.state === 'intent' || ['dispatching', 'running', 'cleanup-unconfirmed'].includes(attempt.status);
  if (uncertainPreparation) add(items, { kind: 'delegation-preparation', id: attempt.id, run, workspace, phase: 'preparation', evidence: { reconciliation: 'legacy-delegation-preparation', attemptId: attempt.id } });
  if (attempt.outputPublication?.state === 'intent') add(items, { kind: 'delegation-publication', id: attempt.id, run, workspace, phase: 'publication', evidence: { reconciliation: 'legacy-delegation-publication', attemptId: attempt.id } });
  if (attempt.verification?.checks.some(check => ['dispatching', 'running', 'cleanup-unconfirmed'].includes(check.state) || check.cleanupConfirmed === false)) add(items, { kind: 'delegation-verification', id: attempt.id, run, workspace, phase: 'verification', evidence: { reconciliation: 'legacy-delegation-verification', attemptId: attempt.id } });
};

/** Imports only deterministic witnesses for writers that were already unfinished at boot. It never probes a path. */
export function reconstructLegacyWorkspaceOwnership(store: Store, ownership: WorkspaceOwnership): void {
  const witnesses: Witness[] = [];
  for (const run of store.runs()) if (uncertainRun(run)) add(witnesses, { kind: 'run', id: run.id, run, workspace: run.workspace, phase: 'runtime', main: true, evidence: { reconciliation: 'legacy-main-run', runId: run.id, status: run.status, cleanupUnconfirmed: Boolean(run.cleanupUnconfirmed) } });
  for (const review of store.reviews()) {
    const run = store.runs().find(item => item.id === review.runId);
    if (run) reviewWitnesses(review, run, witnesses);
  }
  const records = new DelegationRecords(store);
  for (const run of store.runs()) {
    if (run.integration?.status === 'applying') {
      add(witnesses, { kind: 'integration', id: run.id, run, workspace: run.workspace, phase: 'integration', evidence: { reconciliation: 'legacy-integration', runId: run.id } });
      add(witnesses, { kind: 'integration', id: run.id, run, workspace: run.integration.plan.basis.root, phase: 'integration', evidence: { reconciliation: 'legacy-integration', runId: run.id } });
    }
    for (const task of records.tasks(run.id)) for (const attempt of task.attempts) attemptWitnesses(run, attempt, witnesses);
  }
  const retained = operationReceipt(store);
  for (const witness of witnesses) {
    if (hasExactReceipt(retained, witness)) continue;
    const provenance: WorkspaceProvenance = { kind: witness.kind, id: witness.id, projectId: witness.run.projectId, conversationId: witness.run.conversationId, ...(witness.main && witness.run.executionOrigin ? { origin: witness.run.executionOrigin as unknown as Record<string, unknown> } : {}) };
    ownership.retainUncertain({ reservationId: reservationId(witness), ownerId: witness.main ? witness.run.id : `legacy:${witness.kind}:${witness.id}`, ...(witness.main ? {} : { runId: witness.run.id }), workspace: witness.workspace, provenance, phase: witness.phase, cleanupEvidence: witness.evidence });
  }
}
