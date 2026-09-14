import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseProjectContext, type ProjectContextSnapshot } from './project-context.js';
import { workspaceIdentity } from './workspace-identity.js';
import { assertHarnessRoute, readHarnessSettings } from './harness-settings.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import type { WorkspaceLease, WorkspaceProvenance } from './workspace-leases.js';
import type { Store } from './store.js';
import type { Checkpoints } from './checkpoints.js';
import type { ProjectMemory, PreparedMemory } from './memory.js';
import type { Reviews } from './reviews.js';
import type { Pushes } from './pushes.js';
import type { Integrations } from './integrations.js';
import type { ExecutionOrigin } from './execution-origin.js';
import type {
  Conversation,
  HarnessId,
  HarnessInfo,
  HarnessSelection,
  LinkedRunResult,
  Project,
  RerunCheckpointInput,
  RestartCheckpointInput,
  Run,
} from './contracts.js';
import { assertOpen, conversationHasActiveRun, now } from './runtime-status.js';

export const PRE_DISPATCH_RECOVERY_FAILURE =
  'Linked checkpoint recovery failed before native dispatch. No harness was launched.';

type RecoveryContext = {
  projectContext?: ProjectContextSnapshot;
  harness: HarnessId;
  executable?: string;
  executableVersion?: string;
  model: string;
  effort: string;
  executionMode: NonNullable<Run['executionMode']>;
  settingsSource?: Run['settingsSource'];
  projectSettingsRevision?: string | null;
  memory?: PreparedMemory;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  title: string;
};

export type RecoveryHost = {
  isAccepting(): boolean;
  readonly store: Store;
  readonly checkpoints: Checkpoints;
  readonly memory: ProjectMemory;
  readonly reviews: Reviews;
  readonly pushes: Pushes;
  readonly integrations: Integrations;
  readonly executionOrigin: ExecutionOrigin | undefined;
  readonly admission: Set<string>;
  readonly active: Map<string, { controller: AbortController; done: Promise<void>; run: Run }>;
  conversation(id: string): Conversation;
  project(id: string): Project;
  inspectExecutable(harness: HarnessId, executable?: string | null): Promise<HarnessInfo>;
  validateSelection(selection: HarnessSelection, info: HarnessInfo): void;
  validateExecutionMode(mode: NonNullable<Run['executionMode']>, info: HarnessInfo): void;
  preparation(): () => void;
  planWorkspace(
    root: string,
    provenance: WorkspaceProvenance,
    plan: () => string,
    held: Map<string, WorkspaceLease>,
    readOnlyPlanning?: boolean,
  ): { parent: WorkspaceLease; lease: WorkspaceLease; workspace: string };
  transferWorkspace(
    plan: { parent: WorkspaceLease; lease: WorkspaceLease },
    held: Map<string, WorkspaceLease>,
  ): WorkspaceLease;
  releaseWorkspaces(held: Map<string, WorkspaceLease>, failure?: unknown): void;
  observeExecution(run: Run, work: Promise<void>): Promise<void>;
  execute(run: Run, controller: AbortController, lease: WorkspaceLease): Promise<void>;
  finish(run: Run, status: Run['status'], error?: string): void;
  changed(): void;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'The retained checkpoint context is incomplete. Restore files to inspect it without execution.',
    );
  return value as Record<string, unknown>;
}

function plainMessages(values: unknown[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  return values.map((value) => {
    const message = object(value);
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string'
    )
      throw new Error('The retained checkpoint contains invalid conversation context.');
    return { role: message.role, text: message.text };
  });
}

export function recoveryContext(
  metadata: Record<string, unknown>,
  kind: 'restart' | 'rerun',
  sourceRunId: string,
): RecoveryContext {
  const savedRun = object(metadata.run);
  const savedConversation = object(metadata.conversation);
  if (
    savedRun.id !== sourceRunId ||
    typeof savedRun.model !== 'string' ||
    typeof savedRun.effort !== 'string' ||
    (savedRun.executionMode !== 'code' && savedRun.executionMode !== 'read-only')
  )
    throw new Error(
      'The retained checkpoint does not contain a compatible run configuration. Restore files to inspect it without execution.',
    );
  let messages: RecoveryContext['messages'];
  if (savedRun.recoveryMessages !== undefined) {
    if (!Array.isArray(savedRun.recoveryMessages))
      throw new Error('The retained checkpoint contains invalid recovery context.');
    messages = plainMessages(savedRun.recoveryMessages);
  } else {
    if (!Array.isArray(metadata.messages))
      throw new Error(
        'The retained checkpoint does not contain restart context. Restore files to inspect it without execution.',
      );
    messages = metadata.messages.flatMap((value) => {
      const message = object(value);
      if (
        (message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.text !== 'string' ||
        typeof message.id !== 'string' ||
        typeof message.runId !== 'string'
      )
        throw new Error('The retained checkpoint contains invalid conversation context.');
      const isSourceAnswer =
        kind === 'rerun' &&
        message.role === 'assistant' &&
        message.runId === sourceRunId &&
        !message.id.startsWith(`${sourceRunId}:recovery:`);
      return isSourceAnswer
        ? []
        : [{ role: message.role as 'user' | 'assistant', text: message.text }];
    });
  }
  if (!messages.length || typeof savedConversation.title !== 'string')
    throw new Error(
      'The retained checkpoint does not contain restart context. Restore files to inspect it without execution.',
    );
  const harness = savedRun.harness === undefined ? 'codex' : savedRun.harness;
  if (harness !== 'codex' && harness !== 'grok')
    throw new Error(
      'The retained checkpoint contains an unknown harness route. Restore files to inspect it without execution.',
    );
  const settingsSource = savedRun.settingsSource;
  if (
    settingsSource !== undefined &&
    settingsSource !== 'project' &&
    settingsSource !== 'conversation' &&
    settingsSource !== 'native'
  )
    throw new Error('The retained checkpoint contains invalid harness provenance.');
  const projectSettingsRevision = savedRun.projectSettingsRevision;
  if (
    projectSettingsRevision !== undefined &&
    projectSettingsRevision !== null &&
    typeof projectSettingsRevision !== 'string'
  )
    throw new Error('The retained checkpoint contains invalid project settings provenance.');
  let projectContext: ProjectContextSnapshot | undefined;
  if (savedRun.projectContext !== undefined) {
    const saved = savedRun.projectContext as Partial<ProjectContextSnapshot> | null;
    if (
      !saved ||
      typeof saved !== 'object' ||
      saved.error !== undefined ||
      (saved.revision !== null &&
        (typeof saved.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(saved.revision)))
    )
      throw new Error('The retained project context is invalid. Restore files without execution.');
    if (saved.revision === null) {
      const empty = object(saved.value);
      if (
        Object.keys(empty).length !== 3 ||
        empty.purpose !== '' ||
        empty.instructions !== '' ||
        !Array.isArray(empty.documents) ||
        empty.documents.length !== 0
      )
        throw new Error('The retained empty project context is invalid.');
      projectContext = { revision: null, value: { purpose: '', instructions: '', documents: [] } };
    } else projectContext = { revision: saved.revision, value: parseProjectContext(saved.value) };
  }
  return {
    projectContext,
    harness,
    executable: typeof savedRun.executable === 'string' ? savedRun.executable : undefined,
    executableVersion:
      typeof savedRun.executableVersion === 'string' ? savedRun.executableVersion : undefined,
    model: savedRun.model,
    effort: savedRun.effort,
    executionMode: savedRun.executionMode,
    settingsSource,
    projectSettingsRevision,
    memory: savedRun.memory as PreparedMemory | undefined,
    messages,
    title: savedConversation.title,
  };
}

export function assertReconciledExternalActions(metadata: Record<string, unknown>): void {
  if (!Array.isArray(metadata.externalActions))
    throw new Error(
      'The retained checkpoint lacks external-action reconciliation context. Restore files to inspect it without execution.',
    );
  for (const value of metadata.externalActions) {
    const action = object(value);
    const push =
      action.push && typeof action.push === 'object'
        ? (action.push as Record<string, unknown>)
        : undefined;
    const result =
      push?.result && typeof push.result === 'object'
        ? (push.result as Record<string, unknown>)
        : undefined;
    if (
      action.originOperation === 'active' ||
      action.originOperation === 'cleanup-unconfirmed' ||
      action.status === 'delivering' ||
      action.status === 'interrupted' ||
      action.status === 'stop-unconfirmed' ||
      push?.status === 'pushing' ||
      push?.status === 'uncertain' ||
      result?.cleanupVerified === false
    )
      throw new Error(
        'Reconcile the retained external action and process cleanup before linked execution.',
      );
  }
}

export async function recoverLinkedCheckpoint(
  host: RecoveryHost,
  kind: 'restart' | 'rerun',
  input: RestartCheckpointInput | RerunCheckpointInput,
): Promise<LinkedRunResult> {
  assertOpen(host.isAccepting());
  const selected = host.checkpoints.selected(input.runId, input.checkpointDigest);
  const sourceRun = selected.run;
  const sourceConversation = host.conversation(sourceRun.conversationId);
  if (kind === 'restart') {
    if (sourceRun.status !== 'interrupted')
      throw new Error(
        'Only stopped or interrupted work can be restarted. Use rerun for a completed result.',
      );
    const sourceRuns = host.store
      .runs()
      .filter((run) => run.conversationId === sourceConversation.id);
    const sourceIndex = sourceRuns.findIndex((run) => run.id === sourceRun.id);
    const laterRunBlocksRetry = sourceRuns
      .slice(sourceIndex + 1)
      .some(
        (run) =>
          run.recoveryKind !== 'restart' ||
          run.sourceRunId !== sourceRun.id ||
          run.sourceCheckpointDigest !== selected.checkpoint.digest ||
          run.status !== 'failed' ||
          run.error !== PRE_DISPATCH_RECOVERY_FAILURE,
      );
    if (laterRunBlocksRetry)
      throw new Error(
        'Restart applies only to the latest run in this conversation; a newer run already exists.',
      );
    if (sourceRun.checkpoints?.at(-1)?.digest !== selected.checkpoint.digest)
      throw new Error(
        'Restart requires the last safe completed checkpoint; partial work is never recovered silently.',
      );
  } else if (!['completed', 'failed', 'interrupted'].includes(sourceRun.status)) {
    throw new Error(
      'Rerun requires a retained checkpoint from completed, failed, or interrupted work.',
    );
  }
  if (
    host.admission.has(sourceConversation.id) ||
    host.reviews.hasActiveWork(sourceConversation.id) ||
    host.pushes.hasActiveWork(sourceConversation.id) ||
    conversationHasActiveRun(host.store.runs(), sourceConversation.id)
  )
    throw new Error('Wait for active source-conversation work to finish before linked execution.');
  if (
    host.store
      .runs()
      .some((run) => run.conversationId === sourceConversation.id && run.cleanupUnconfirmed) ||
    host.store
      .reviews()
      .some(
        (review) =>
          review.conversationId === sourceConversation.id &&
          (review.originOperation === 'cleanup-unconfirmed' ||
            review.push?.result?.cleanupVerified === false),
      )
  )
    throw new Error('Reconcile process cleanup before linked execution.');
  if (
    host.store
      .reviews()
      .some(
        (review) =>
          review.conversationId === sourceConversation.id &&
          review.deliveryPlan &&
          review.status !== 'delivered' &&
          review.status !== 'stale',
      )
  )
    throw new Error(
      'Reconcile the prior delivery outcome before linked execution; approved effects are never replayed.',
    );
  if (host.integrations.blocksNewWork(sourceConversation.id))
    throw new Error('Finish interrupted parent integration before linked execution.');
  assertReconciledExternalActions(selected.manifest.metadata);
  const context = recoveryContext(selected.manifest.metadata, kind, sourceRun.id);
  host.admission.add(sourceConversation.id);
  let targetConversationId: string | undefined;
  let run: Run | undefined;
  const prepared = host.preparation();
  const held = new Map<string, WorkspaceLease>();
  let preparationFailure: unknown;
  try {
    const project = host.project(sourceRun.projectId);
    const settings = readHarnessSettings(project.root);
    if (settings.error) throw new Error(settings.error);
    const info = await host.inspectExecutable(context.harness, context.executable);
    const freshSettings = readHarnessSettings(project.root);
    if (freshSettings.error) throw new Error(freshSettings.error);
    if (freshSettings.revision !== settings.revision)
      throw new Error('Project harness settings changed during discovery. Try again.');
    assertHarnessRoute(settings, context.harness, info.executable);
    if (context.executableVersion && info.version !== context.executableVersion)
      throw new Error(
        'The checkpoint CLI version changed. Restore files to inspect it; this checkpoint cannot silently switch executables.',
      );
    assertOpen(host.isAccepting());
    host.validateSelection(
      { harness: context.harness, model: context.model, effort: context.effort },
      info,
    );
    host.validateExecutionMode(context.executionMode, info);
    const createdAt = now();
    const runId = randomUUID();
    const targetConversation: Conversation =
      kind === 'restart'
        ? {
            ...host.conversation(sourceConversation.id),
            harness: context.harness,
            model: context.model,
            effort: context.effort,
            executionMode: context.executionMode,
            updatedAt: createdAt,
          }
        : {
            id: randomUUID(),
            projectId: project.id,
            sourceConversationId: sourceConversation.id,
            title: `Rerun: ${context.title}`,
            harness: context.harness,
            model: context.model,
            effort: context.effort,
            executionMode: context.executionMode,
            createdAt,
            updatedAt: createdAt,
            lastReadSequence: 0,
          };
    targetConversationId = targetConversation.id;
    if (targetConversation.id !== sourceConversation.id) host.admission.add(targetConversation.id);
    const planned = host.planWorkspace(
      project.root,
      { kind: 'run', id: runId, projectId: project.id, conversationId: targetConversation.id },
      () => join(project.root, '.worktrees', `randolph-${runId}`),
      held,
    );
    const workspace = planned.workspace;
    run = {
      harnessAuthorizationRevision: settings.revision,
      enabledHarnessRoutes:
        settings.enabledRoutes?.map((route) => ({ ...route })) ??
        (info.executable ? [{ harness: context.harness, executable: info.executable }] : []),
      executionOrigin: host.executionOrigin,
      projectContext: context.projectContext,
      harness: context.harness,
      executable: info.executable,
      executableVersion: info.version,
      id: runId,
      projectId: project.id,
      conversationId: targetConversation.id,
      sourceRunId: sourceRun.id,
      sourceCheckpointDigest: selected.checkpoint.digest,
      recoveryKind: kind,
      recoveryMessages: context.messages,
      status: 'starting',
      model: context.model,
      effort: context.effort,
      executionMode: context.executionMode,
      settingsSource: context.settingsSource,
      projectSettingsRevision: context.projectSettingsRevision,
      memory: context.memory,
      workspace,
      createdAt,
      updatedAt: createdAt,
      lastActivityAt: createdAt,
    };
    run.logsPath = join(host.store.runDirectory(run), 'logs');
    host.store.transaction(() => {
      host.store.putConversation(targetConversation);
      host.store.putRun(run!);
      if (kind === 'rerun')
        for (const [index, message] of context.messages.entries())
          host.store.putMessage({
            ...message,
            id: `${runId}:recovery:${index}`,
            runId,
            conversationId: targetConversation.id,
            createdAt,
          });
      host.store.append(
        run!,
        kind === 'restart' ? 'run.restart-requested' : 'run.rerun-requested',
        kind === 'restart'
          ? 'Explicit restart requested from the last safe checkpoint'
          : 'Explicit rerun requested in a linked conversation',
        {
          sourceRunId: sourceRun.id,
          sourceConversationId: sourceConversation.id,
          checkpointDigest: selected.checkpoint.digest,
          harness: context.harness,
          executable: info.executable,
          executableVersion: info.version,
          workspace,
        },
      );
    });
    try {
      if (context.memory) host.memory.retain(project.id, run.id, context.memory);
      host.store.exportRun(run);
      const restored = host.checkpoints.restoreWorktree(
        sourceRun.id,
        selected.checkpoint.digest,
        project.root,
        run.id,
      );
      if (restored.workspace !== run.workspace)
        throw new Error('Linked checkpoint restored to an unexpected workspace.');
      run.workspaceIdentity = workspaceIdentity(run.workspace);
      if (kind === 'restart') host.reviews.invalidate(sourceConversation.id);
      host.checkpoints.capture(run, 'before-turn');
    } catch (cause) {
      preparationFailure = cause;
      host.checkpoints.failed(run, cause);
      run.cleanupUnconfirmed = !workspaceCleanupConfirmed(cause);
      host.finish(run, 'failed', PRE_DISPATCH_RECOVERY_FAILURE);
      throw cause;
    }
    const controller = new AbortController();
    const state = { controller, done: Promise.resolve(), run };
    const lease = host.transferWorkspace(planned, held);
    host.active.set(run.id, state);
    state.done = host.observeExecution(run, host.execute(run, controller, lease));
    host.changed();
    return { conversation: targetConversation, run: { ...run } };
  } catch (error) {
    if (workspaceCleanupConfirmed(preparationFailure)) preparationFailure = error;
    if (
      run &&
      !host.active.has(run.id) &&
      host.store.runs().some((value) => value.id === run!.id)
    ) {
      run.cleanupUnconfirmed ||= !workspaceCleanupConfirmed(preparationFailure);
      if (run.status === 'starting') host.finish(run, 'failed', PRE_DISPATCH_RECOVERY_FAILURE);
      else host.store.putRun(run);
    }
    throw error;
  } finally {
    try {
      host.releaseWorkspaces(held, preparationFailure);
    } finally {
      host.admission.delete(sourceConversation.id);
      if (targetConversationId) host.admission.delete(targetConversationId);
      prepared();
    }
  }
}
