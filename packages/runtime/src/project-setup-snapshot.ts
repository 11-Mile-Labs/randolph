import { parseSetupProposal } from './project-setup.js';
import { readProjectContext } from './project-context.js';
import { assertWorkspaceIdentity } from './workspace-identity.js';
import { cleanupReconciliationReason, type ExecutionOrigin } from './execution-origin.js';
import type { Store } from './store.js';
import type { WorkspaceOwnership } from './workspace-ownership.js';
import type { DelegationCommands } from './delegation-commands.js';
import { ACTIVE_RUN_STATUSES } from './runtime-status.js';
import type { Project, ProjectSetupSnapshot, Run } from './contracts.js';

/**
 * Read-only capabilities the cleanup-eligibility policy needs. Kept separate so the
 * command workflow can reuse the same rule inside its transaction without the
 * projection reaching back into the command module.
 */
export type ProjectSetupCleanupSource = {
  ownership: Pick<WorkspaceOwnership, 'snapshot'>;
  delegation: { records: Pick<DelegationCommands['records'], 'setupSessionCleanupReason'> };
  executionOrigin: ExecutionOrigin | undefined;
};

/** Exactly the read operations the projection performs; never a mutable runtime host. */
export type ProjectSetupSnapshotSource = ProjectSetupCleanupSource & {
  store: Pick<Store, 'conversations' | 'runs' | 'messages' | 'events'>;
  setupAdmission: ReadonlySet<string>;
  active: ReadonlyMap<string, { run: Run }>;
  project(id: string): Project;
};

export function setupCleanupReason(host: ProjectSetupCleanupSource, runId: string): string | null {
  const nativeReason = host.delegation.records.setupSessionCleanupReason(
    runId,
    host.executionOrigin,
  );
  if (nativeReason) return nativeReason;
  for (const lease of host.ownership
    .snapshot()
    .filter(
      (value) =>
        ['run', 'main-run'].includes(value.provenance?.kind ?? '') &&
        value.provenance?.id === runId,
    )) {
    const reason = cleanupReconciliationReason(lease.provenance?.origin, host.executionOrigin);
    if (reason) return reason;
  }
  return null;
}

export function projectSetupSnapshot(
  host: ProjectSetupSnapshotSource,
  projectId: string,
): ProjectSetupSnapshot {
  const project = host.project(projectId);
  const context = readProjectContext(project.root);
  const conversations = new Set(
    host.store
      .conversations()
      .filter(
        (conversation) =>
          conversation.projectId === projectId && conversation.kind === 'project-setup',
      )
      .map((conversation) => conversation.id),
  );
  const runs = host.store.runs().filter((run) => conversations.has(run.conversationId));
  const busy =
    host.setupAdmission.has(projectId) ||
    runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status) || run.cleanupUnconfirmed);
  const uncertain = runs.filter(
    (run) => run.cleanupUnconfirmed || run.status === 'stop-unconfirmed',
  );
  const cleanupReason = uncertain
    .map((run) => setupCleanupReason(host, run.id))
    .find((reason) => reason !== null);
  const cleanup = uncertain.length
    ? {
        canReconcile:
          !host.setupAdmission.has(projectId) &&
          !runs.some((run) => host.active.has(run.id)) &&
          !cleanupReason,
        reason:
          cleanupReason ??
          'A later boot on the original Mac confirms that the previous inspection processes have exited. Verify cleanup before starting another inspection.',
      }
    : undefined;
  return {
    context,
    cleanup,
    inspections: runs.map((run) => {
      let proposal;
      let error;
      if (run.status === 'completed') {
        try {
          proposal = parseSetupProposal(
            host.store
              .messages(run.conversationId)
              .filter((message) => message.runId === run.id && message.role === 'assistant')
              .map((message) => message.text)
              .join(''),
          );
        } catch (cause) {
          error = cause instanceof Error ? cause.message : 'Invalid setup proposal.';
        }
        try {
          if (!run.workspaceIdentity)
            throw new Error(
              'This inspection lacks project directory identity. Inspect again before approving.',
            );
          assertWorkspaceIdentity(project.root, run.workspaceIdentity);
        } catch (cause) {
          error =
            cause instanceof Error
              ? cause.message
              : 'Project directory changed. Inspect again before approving.';
        }
      } else if (run.status === 'failed') error = run.error;
      const events = host.store.events(run.id);
      const approved = events.findLast((event) => event.type === 'project-context.approved');
      const pendingApproval =
        !approved && events.some((event) => event.type === 'project-context.approval-requested');
      if (pendingApproval)
        error =
          'The approval write has no confirmed receipt. Review the current approved context above, then inspect again before approving further changes.';
      return {
        conversationId: run.conversationId,
        run,
        proposal,
        error,
        canApprove:
          !busy &&
          !error &&
          !approved &&
          !pendingApproval &&
          run.id === runs.at(-1)?.id &&
          Boolean(proposal) &&
          !context.error &&
          run.projectContext?.revision === context.revision,
        ...(typeof approved?.data.revision === 'string'
          ? { approvedRevision: approved.data.revision }
          : {}),
      };
    }),
  };
}
