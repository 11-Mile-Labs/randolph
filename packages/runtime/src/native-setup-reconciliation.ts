import { canonicalJson } from './canonical-json.js';
import type { Store } from './store.js';

/**
 * Setup reconciliation eligibility for native operations: whether this run may settle quarantined
 * setup work at all, and whether one operation carries the durable later-boot session proof.
 *
 * Every read below is the caller's current row, so `setupReconciliationProof` must be called from
 * inside the caller's `store.transaction` callback, before any write. Nothing structural enforces
 * that: `Store.transaction` only rejects a thenable return value and its depth counter is private,
 * so this is a call-site convention, the same one the sibling session policy relies on where
 * `setupSessionCleanupReason` is evaluated inside `reconcileProjectSetupSessions`.
 */

type SetupReconciliationSession = {
  id: string;
  role: string;
  state: string;
  cleanupConfirmed?: boolean;
  cleanupEvidence?: Record<string, unknown>;
  origin?: Record<string, unknown>;
};

export type SetupReconciliationEvidence = { reconciliation: 'later-boot'; sessionId: string };

export type SetupReconciliationProof = {
  /** Throws unless this quarantined model-turn operation carries the durable later-boot proof. */
  settlement(operation: {
    origin: Record<string, unknown>;
    sessionId?: string;
  }): SetupReconciliationEvidence;
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));

export function setupReconciliationProof(store: Store, runId: string): SetupReconciliationProof {
  const run = store.runs().find((item) => item.id === runId),
    conversation = run && store.conversations().find((item) => item.id === run.conversationId);
  if (
    !run ||
    !conversation ||
    conversation.kind !== 'project-setup' ||
    run.executionMode !== 'read-only' ||
    run.cleanupUnconfirmed ||
    run.status !== 'interrupted'
  )
    throw new Error(
      'Only durably reconciled read-only project setup runs may settle native operations.',
    );
  if (
    store.db.prepare('SELECT 1 FROM delegation_tasks WHERE run_id=? LIMIT 1').get(runId) ||
    store.db.prepare('SELECT 1 FROM delegation_controls WHERE run_id=? LIMIT 1').get(runId) ||
    store.db.prepare('SELECT 1 FROM delegation_tool_receipts WHERE run_id=? LIMIT 1').get(runId)
  )
    throw new Error('Project setup reconciliation cannot settle delegated native operations.');
  const sessions = (
    store.db
      .prepare('SELECT document FROM delegation_sessions WHERE run_id=?')
      .all(runId) as Array<{ document: string }>
  ).map((row) => JSON.parse(row.document) as SetupReconciliationSession);
  return {
    settlement(operation) {
      const session = sessions.find((value) => value.id === operation.sessionId);
      if (
        !session ||
        session.role !== 'main' ||
        session.state !== 'interrupted' ||
        session.cleanupConfirmed !== true ||
        session.cleanupEvidence?.reconciliation !== 'later-boot' ||
        !same(operation.origin, session.origin) ||
        !same(operation.origin, run.executionOrigin)
      )
        throw new Error(
          'Setup native operation lacks the durable later-boot session reconciliation proof.',
        );
      return { reconciliation: 'later-boot', sessionId: session.id };
    },
  };
}
