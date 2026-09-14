import { randomUUID } from 'node:crypto';
import { parseSetupProposal, setupPrompt } from './project-setup.js';
import { readProjectContext, writeProjectContext, parseProjectContext, type ProjectContextSnapshot } from './project-context.js';
import { assertWorkspaceIdentity } from './workspace-identity.js';
import { cleanupReconciliationReason, type ExecutionOrigin } from './execution-origin.js';
import type { Store } from './store.js';
import type { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceLease } from './workspace-leases.js';
import type { RunWorkspace } from './run-workspace.js';
import type { DelegationCommands } from './delegation-commands.js';
import type { NativeAdmission } from './native-admission.js';
import { ACTIVE_RUN_STATUSES, now } from './runtime-status.js';
import type { ApproveProjectSetupInput, Conversation, InspectProjectInput, Project, ProjectSetupSnapshot, Run, SendInput } from './contracts.js';

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
  send(input: SendInput, setup: { executable?: string; expectedContextRevision: string | null }): Promise<Run>;
  changed(): void;
};

function setupCleanupReason(host: ProjectSetupHost, runId: string): string | null {
  const nativeReason = host.delegation.records.setupSessionCleanupReason(runId, host.executionOrigin);
  if (nativeReason) return nativeReason;
  for (const lease of host.ownership.snapshot().filter(value => ['run', 'main-run'].includes(value.provenance?.kind ?? '') && value.provenance?.id === runId)) {
    const reason = cleanupReconciliationReason(lease.provenance?.origin, host.executionOrigin);
    if (reason) return reason;
  }
  return null;
}

export function projectSetupSnapshot(host: ProjectSetupHost, projectId: string): ProjectSetupSnapshot {
  const project = host.project(projectId);
  const context = readProjectContext(project.root);
  const conversations = new Set(host.store.conversations().filter(conversation => conversation.projectId === projectId && conversation.kind === 'project-setup').map(conversation => conversation.id));
  const runs = host.store.runs().filter(run => conversations.has(run.conversationId));
  const busy = host.setupAdmission.has(projectId) || runs.some(run => ACTIVE_RUN_STATUSES.has(run.status) || run.cleanupUnconfirmed);
  const uncertain = runs.filter(run => run.cleanupUnconfirmed || run.status === 'stop-unconfirmed');
  const cleanupReason = uncertain.map(run => setupCleanupReason(host, run.id)).find(reason => reason !== null);
  const cleanup = uncertain.length ? { canReconcile: !host.setupAdmission.has(projectId) && !runs.some(run => host.active.has(run.id)) && !cleanupReason, reason: cleanupReason ?? 'A later boot on the original Mac confirms that the previous inspection processes have exited. Verify cleanup before starting another inspection.' } : undefined;
  return { context, cleanup, inspections: runs.map(run => {
    let proposal; let error;
    if (run.status === 'completed') {
      try { proposal = parseSetupProposal(host.store.messages(run.conversationId).filter(message => message.runId === run.id && message.role === 'assistant').map(message => message.text).join('')); }
      catch (cause) { error = cause instanceof Error ? cause.message : 'Invalid setup proposal.'; }
      try {
        if (!run.workspaceIdentity) throw new Error('This inspection lacks project directory identity. Inspect again before approving.');
        assertWorkspaceIdentity(project.root, run.workspaceIdentity);
      } catch (cause) { error = cause instanceof Error ? cause.message : 'Project directory changed. Inspect again before approving.'; }
    } else if (run.status === 'failed') error = run.error;
    const events = host.store.events(run.id);
    const approved = events.findLast(event => event.type === 'project-context.approved');
    const pendingApproval = !approved && events.some(event => event.type === 'project-context.approval-requested');
    if (pendingApproval) error = 'The approval write has no confirmed receipt. Review the current approved context above, then inspect again before approving further changes.';
    return { conversationId: run.conversationId, run, proposal, error, canApprove: !busy && !error && !approved && !pendingApproval && run.id === runs.at(-1)?.id && Boolean(proposal) && !context.error && run.projectContext?.revision === context.revision, ...(typeof approved?.data.revision === 'string' ? { approvedRevision: approved.data.revision } : {}) };
  }) };
}

export function reconcileProjectSetupCleanup(host: ProjectSetupHost, projectId: string): ProjectSetupSnapshot {
  if (!host.isAccepting()) throw new Error('Application is closing.');
  const snapshot = projectSetupSnapshot(host, projectId);
  if (host.setupAdmission.has(projectId) || snapshot.inspections.some(item => host.active.has(item.run.id) || host.admission.has(item.conversationId))) throw new Error('Wait for active inspection work to finish before verifying cleanup.');
  if (!snapshot.cleanup) return snapshot;
  if (!snapshot.cleanup.canReconcile) throw new Error(snapshot.cleanup.reason);
  host.setupAdmission.add(projectId);
  try {
    host.store.transaction(() => {
      for (const { run } of snapshot.inspections) {
        if (!run.cleanupUnconfirmed && run.status !== 'stop-unconfirmed') continue;
        const reason = setupCleanupReason(host, run.id);
        if (reason) throw new Error(reason);
        const workspaces = host.ownership.snapshot().filter(lease => ['run', 'main-run'].includes(lease.provenance?.kind ?? '') && lease.provenance?.id === run.id);
        for (const lease of workspaces) {
          const workspaceReason = cleanupReconciliationReason(lease.provenance?.origin, host.executionOrigin);
          if (workspaceReason) throw new Error(workspaceReason);
        }
        host.delegation.records.reconcileProjectSetupSessions(run.id, host.executionOrigin);
        for (const lease of workspaces) host.ownership.release({ ...lease, cleanupConfirmed: true, cleanupEvidence: { reconciliation: 'later-boot-original-setup-owner', recordedOrigin: lease.provenance!.origin!, observedOrigin: host.executionOrigin! } });
        run.status = 'interrupted'; run.cleanupUnconfirmed = false; run.updatedAt = now();
        run.error = 'Previous inspection execution ended with an earlier boot on this Mac. No work has been restarted.';
        host.store.putRun(run);
        host.store.append(run, 'run.cleanup-reconciled', run.error, { recordedOrigin: run.executionOrigin, observedOrigin: host.executionOrigin });
      }
    });
    for (const { run } of snapshot.inspections) if (run.status === 'interrupted' && !run.cleanupUnconfirmed) host.nativeAdmission.reconcileSetupCleanup(run.id);
  } finally { host.setupAdmission.delete(projectId); host.changed(); }
  return projectSetupSnapshot(host, projectId);
}

export async function inspectProject(host: ProjectSetupHost, input: InspectProjectInput): Promise<Run> {
  if (!host.isAccepting()) throw new Error('Application is closing.');
  const project = host.project(input.projectId);
  if (host.setupAdmission.has(project.id) || projectSetupSnapshot(host, project.id).inspections.some(item => ACTIVE_RUN_STATUSES.has(item.run.status) || item.run.cleanupUnconfirmed)) throw new Error('Project inspection is already active or awaiting cleanup.');
  host.setupAdmission.add(project.id);
  try {
    const context = readProjectContext(project.root);
    if (context.error) throw new Error(context.error);
    const prompt = setupPrompt(context, input.brief);
    let conversation = host.store.conversations().findLast(item => item.projectId === project.id && item.kind === 'project-setup');
    if (!conversation) {
      conversation = { ...host.createConversation(project.id), kind: 'project-setup', title: 'Project setup' };
      host.store.putConversation(conversation);
    }
    return await host.send({ conversationId: conversation.id, text: prompt, ...input.selection }, { executable: input.executable, expectedContextRevision: context.revision });
  } finally { host.setupAdmission.delete(project.id); host.changed(); }
}

export function approveProjectSetup(host: ProjectSetupHost, input: ApproveProjectSetupInput): ProjectContextSnapshot {
  if (!host.isAccepting()) throw new Error('Application is closing.');
  const snapshot = projectSetupSnapshot(host, input.projectId);
  const inspection = snapshot.inspections.find(item => item.run.id === input.runId);
  if (!inspection?.canApprove || inspection.proposal?.revision !== input.proposalRevision || inspection.run.projectContext?.revision !== input.expectedContextRevision) throw new Error('This proposal or approved context changed. Reload project setup before approving.');
  const value = parseProjectContext(input.value);
  const held = new Map<string, WorkspaceLease>();
  let failure: unknown;
  const lease = host.workspaces.own(host.project(input.projectId).root, { kind: 'setup-approval', id: randomUUID(), projectId: input.projectId, conversationId: inspection.run.conversationId }, held);
  try {
    host.ownership.assert(lease);
    host.store.append(inspection.run, 'project-context.approval-requested', 'Project context approval requested', { proposalRevision: input.proposalRevision, expectedContextRevision: input.expectedContextRevision, value });
    assertWorkspaceIdentity(host.project(input.projectId).root, inspection.run.workspaceIdentity!);
    const saved = writeProjectContext(host.project(input.projectId).root, value, input.expectedContextRevision);
    host.store.append(inspection.run, 'project-context.approved', 'Project context approved', { proposalRevision: input.proposalRevision, revision: saved.revision, value: saved.value });
    host.store.exportRun(inspection.run);
    return saved;
  } catch (error) { failure = error; throw error; }
  finally { host.workspaces.release(held, failure); host.changed(); }
}
