import { randomUUID } from 'node:crypto';
import { setupPrompt } from './project-setup.js';
import {
  readProjectContext,
  writeProjectContext,
  parseProjectContext,
  type ProjectContextSnapshot,
} from './project-context.js';
import { assertWorkspaceIdentity } from './workspace-identity.js';
import { projectSetupSnapshot, setupCleanupReason } from './project-setup-snapshot.js';
import { cleanupReconciliationReason, type ExecutionOrigin } from './execution-origin.js';
import type { Store } from './store.js';
import type { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceLease } from './workspace-leases.js';
import type { RunWorkspace } from './run-workspace.js';
import type { DelegationCommands } from './delegation-commands.js';
import type { NativeAdmission } from './native-admission.js';
import { ACTIVE_RUN_STATUSES, assertOpen, now } from './runtime-status.js';
import type {
  ApproveProjectSetupInput,
  Conversation,
  InspectProjectInput,
  Project,
  ProjectSetupSnapshot,
  Run,
  SendInput,
} from './contracts.js';

export type ProjectSetupHost = {
  isAccepting(): boolean;
  store: Store;
  workspaces: RunWorkspace;
  ownership: WorkspaceOwnership;
  delegation: DelegationCommands;
  nativeAdmission: NativeAdmission;
  executionOrigin: ExecutionOrigin | undefined;
  admission: Set<string>;
  setupAdmission: Set<string>;
  active: Map<string, { run: Run }>;
  project(id: string): Project;
  createConversation(projectId: string): Conversation;
  send(
    input: SendInput,
    setup: { executable?: string; expectedContextRevision: string | null },
  ): Promise<Run>;
  changed(): void;
};

export { projectSetupSnapshot };

export function reconcileProjectSetupCleanup(
  host: ProjectSetupHost,
  projectId: string,
): ProjectSetupSnapshot {
  assertOpen(host.isAccepting());
  const snapshot = projectSetupSnapshot(host, projectId);
  if (
    host.setupAdmission.has(projectId) ||
    snapshot.inspections.some(
      (item) => host.active.has(item.run.id) || host.admission.has(item.conversationId),
    )
  )
    throw new Error('Wait for active inspection work to finish before verifying cleanup.');
  if (!snapshot.cleanup) return snapshot;
  if (!snapshot.cleanup.canReconcile) throw new Error(snapshot.cleanup.reason);
  host.setupAdmission.add(projectId);
  try {
    host.store.transaction(() => {
      for (const { run } of snapshot.inspections) {
        if (!run.cleanupUnconfirmed && run.status !== 'stop-unconfirmed') continue;
        const reason = setupCleanupReason(host, run.id);
        if (reason) throw new Error(reason);
        const workspaces = host.ownership
          .snapshot()
          .filter(
            (lease) =>
              ['run', 'main-run'].includes(lease.provenance?.kind ?? '') &&
              lease.provenance?.id === run.id,
          );
        for (const lease of workspaces) {
          const workspaceReason = cleanupReconciliationReason(
            lease.provenance?.origin,
            host.executionOrigin,
          );
          if (workspaceReason) throw new Error(workspaceReason);
        }
        host.delegation.records.reconcileProjectSetupSessions(run.id, host.executionOrigin);
        for (const lease of workspaces)
          host.ownership.release({
            ...lease,
            cleanupConfirmed: true,
            cleanupEvidence: {
              reconciliation: 'later-boot-original-setup-owner',
              recordedOrigin: lease.provenance!.origin!,
              observedOrigin: host.executionOrigin!,
            },
          });
        run.status = 'interrupted';
        run.cleanupUnconfirmed = false;
        run.updatedAt = now();
        run.error =
          'Previous inspection execution ended with an earlier boot on this Mac. No work has been restarted.';
        host.store.putRun(run);
        host.store.append(run, 'run.cleanup-reconciled', run.error, {
          recordedOrigin: run.executionOrigin,
          observedOrigin: host.executionOrigin,
        });
      }
    });
    for (const { run } of snapshot.inspections)
      if (run.status === 'interrupted' && !run.cleanupUnconfirmed)
        host.nativeAdmission.reconcileSetupCleanup(run.id);
  } finally {
    host.setupAdmission.delete(projectId);
    host.changed();
  }
  return projectSetupSnapshot(host, projectId);
}

export async function inspectProject(
  host: ProjectSetupHost,
  input: InspectProjectInput,
): Promise<Run> {
  assertOpen(host.isAccepting());
  const project = host.project(input.projectId);
  if (
    host.setupAdmission.has(project.id) ||
    projectSetupSnapshot(host, project.id).inspections.some(
      (item) => ACTIVE_RUN_STATUSES.has(item.run.status) || item.run.cleanupUnconfirmed,
    )
  )
    throw new Error('Project inspection is already active or awaiting cleanup.');
  host.setupAdmission.add(project.id);
  try {
    const context = readProjectContext(project.root);
    if (context.error) throw new Error(context.error);
    const prompt = setupPrompt(context, input.brief);
    let conversation = host.store
      .conversations()
      .findLast((item) => item.projectId === project.id && item.kind === 'project-setup');
    if (!conversation) {
      conversation = {
        ...host.createConversation(project.id),
        kind: 'project-setup',
        title: 'Project setup',
      };
      host.store.putConversation(conversation);
    }
    return await host.send(
      { conversationId: conversation.id, text: prompt, ...input.selection },
      { executable: input.executable, expectedContextRevision: context.revision },
    );
  } finally {
    host.setupAdmission.delete(project.id);
    host.changed();
  }
}

export function approveProjectSetup(
  host: ProjectSetupHost,
  input: ApproveProjectSetupInput,
): ProjectContextSnapshot {
  assertOpen(host.isAccepting());
  const snapshot = projectSetupSnapshot(host, input.projectId);
  const inspection = snapshot.inspections.find((item) => item.run.id === input.runId);
  if (
    !inspection?.canApprove ||
    inspection.proposal?.revision !== input.proposalRevision ||
    inspection.run.projectContext?.revision !== input.expectedContextRevision
  )
    throw new Error(
      'This proposal or approved context changed. Reload project setup before approving.',
    );
  const value = parseProjectContext(input.value);
  const held = new Map<string, WorkspaceLease>();
  let failure: unknown;
  const lease = host.workspaces.own(
    host.project(input.projectId).root,
    {
      kind: 'setup-approval',
      id: randomUUID(),
      projectId: input.projectId,
      conversationId: inspection.run.conversationId,
    },
    held,
  );
  try {
    host.ownership.assert(lease);
    host.store.append(
      inspection.run,
      'project-context.approval-requested',
      'Project context approval requested',
      {
        proposalRevision: input.proposalRevision,
        expectedContextRevision: input.expectedContextRevision,
        value,
      },
    );
    assertWorkspaceIdentity(host.project(input.projectId).root, inspection.run.workspaceIdentity!);
    const saved = writeProjectContext(
      host.project(input.projectId).root,
      value,
      input.expectedContextRevision,
    );
    host.store.append(inspection.run, 'project-context.approved', 'Project context approved', {
      proposalRevision: input.proposalRevision,
      revision: saved.revision,
      value: saved.value,
    });
    host.store.exportRun(inspection.run);
    return saved;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    host.workspaces.release(held, failure);
    host.changed();
  }
}
