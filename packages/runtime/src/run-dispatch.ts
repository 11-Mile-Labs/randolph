import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertWorkspaceIdentity, workspaceIdentity } from './workspace-identity.js';
import { readProjectContext } from './project-context.js';
import { assertHarnessRoute, readHarnessSettings } from './harness-settings.js';
import { inspectGitWorkspace } from './git-review.js';
import { prepareWorkspace, plannedConversationWorkspace } from './workspace.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import type { WorkspaceLease } from './workspace-leases.js';
import type { Store } from './store.js';
import type { RunWorkspace } from './run-workspace.js';
import type { WorkspaceOwnership } from './workspace-ownership.js';
import type { ProjectMemory } from './memory.js';
import type { Checkpoints } from './checkpoints.js';
import type { Reviews } from './reviews.js';
import type { Pushes } from './pushes.js';
import type { Integrations } from './integrations.js';
import type { ExecutionOrigin } from './execution-origin.js';
import type { RuntimeHarness } from './runtime-harness.js';
import { ACTIVE_RUN_STATUSES, now } from './runtime-status.js';
import type { Conversation, HarnessSelection, Project, Run, SendInput } from './contracts.js';

export type DispatchHost = {
  isAccepting(): boolean;
  store: Store;
  workspaces: RunWorkspace;
  ownership: WorkspaceOwnership;
  harness: RuntimeHarness;
  memory: ProjectMemory;
  checkpoints: Checkpoints;
  reviews: Reviews;
  pushes: Pushes;
  integrations: Integrations;
  executionOrigin: ExecutionOrigin | undefined;
  admission: Set<string>;
  active: Map<string, { controller: AbortController; done: Promise<void>; run: Run }>;
  conversation(id: string): Conversation;
  project(id: string): Project;
  planWorkspace(root: string, provenance: { kind: string; id: string; projectId?: string; conversationId?: string }, plan: () => string, held: Map<string, WorkspaceLease>, readOnlyPlanning?: boolean): { parent: WorkspaceLease; lease: WorkspaceLease; workspace: string };
  execute(run: Run, controller: AbortController, lease: WorkspaceLease): Promise<void>;
  finish(run: Run, status: Run['status'], error?: string): void;
  changed(): void;
};

export async function dispatchOrdinaryRun(host: DispatchHost, input: SendInput, setup?: { executable?: string; expectedContextRevision: string | null }): Promise<Run> {
  if (!host.isAccepting()) throw new Error('Application is closing.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64_000) throw new Error('Enter a message of at most 64,000 characters.');
  let conversation = host.conversation(input.conversationId);
  if (conversation.kind === 'project-setup' && !setup) throw new Error('Use the dedicated project inspection action for setup conversations.');
  if (host.admission.has(conversation.id) || host.reviews.hasActiveWork(conversation.id) || host.pushes.hasActiveWork(conversation.id) || host.store.runs().some(run => run.conversationId === conversation.id && (ACTIVE_RUN_STATUSES.has(run.status) || run.cleanupUnconfirmed))) throw new Error('This conversation already has active work.');
  if (host.integrations.blocksNewWork(conversation.id)) throw new Error('Finish interrupted parent integration before starting new work.');
  host.admission.add(conversation.id);
  const prepared = host.workspaces.preparation();
  const held = new Map<string, WorkspaceLease>();
  let preparationFailure: unknown;
  let createdRun: Run | undefined;
  try {
    const project = host.project(conversation.projectId);
    const rootIdentity = workspaceIdentity(project.root);
    const settings = readHarnessSettings(project.root);
    if (settings.error) throw new Error(settings.error);
    const savedSelection = host.harness.selectionFor(conversation);
    const explicit = input.harness !== undefined || input.model !== undefined || input.effort !== undefined;
    const defaultHarness = settings.defaults?.harness ?? 'codex';
    const selectedHarness = input.harness ?? savedSelection?.harness ?? settings.defaults?.harness ?? 'codex';
    const sameHarnessSelection = savedSelection?.harness === selectedHarness ? savedSelection : settings.defaults?.harness === selectedHarness ? settings.defaults : undefined;
    const selection: HarnessSelection = explicit
      ? { harness: selectedHarness, model: input.model ?? sameHarnessSelection?.model ?? '', effort: input.effort ?? sameHarnessSelection?.effort ?? '' }
      : savedSelection ?? settings.defaults ?? { harness: defaultHarness, model: '', effort: '' };
    const info = await host.harness.inspectExecutable(selection.harness, setup?.executable ?? (settings.defaults?.harness === selection.harness ? settings.defaults.executable : undefined));
    if (!host.isAccepting()) throw new Error('Application is closing.');
    conversation = host.conversation(input.conversationId);
    assertWorkspaceIdentity(project.root, rootIdentity);
    const freshSettings = readHarnessSettings(project.root);
    if (freshSettings.error) throw new Error(freshSettings.error);
    if (freshSettings.revision !== settings.revision) throw new Error('Project harness settings changed during discovery. Try again.');
    if (!selection.model && !selection.effort && !savedSelection && !settings.defaults) {
      selection.model = info.models[0]?.id ?? '';
      selection.effort = info.models[0]?.defaultEffort ?? '';
    }
    assertHarnessRoute(settings, selection.harness, info.executable);
    host.harness.validateSelection(selection, info);
    const projectContext = readProjectContext(project.root);
    if (projectContext.error) throw new Error(projectContext.error);
    if (setup && projectContext.revision !== setup.expectedContextRevision) throw new Error('Project context changed during setup discovery. Inspect again with the current context.');
    const memory = host.memory.prepare(project.id, input.text);
    const settingsSource = explicit || savedSelection ? 'conversation' : settings.defaults ? 'project' : 'native';
    const executionMode = conversation.executionMode ?? 'read-only';
    if (conversation.kind === 'project-setup' && executionMode !== 'read-only') throw new Error('Project setup is read-only.');
    host.harness.validateExecutionMode(executionMode, info);
    const previousRun = host.store.runs().findLast(run => run.conversationId === conversation.id);
    const recoveryMessages = previousRun?.recoveryMessages
      ? [
          ...previousRun.recoveryMessages.map(message => ({ ...message })),
          ...host.store.messages(conversation.id).filter(message => message.runId === previousRun.id && !message.id.startsWith(`${previousRun.id}:recovery:`)).map(({ role, text }) => ({ role, text })),
          { role: 'user' as const, text: input.text },
        ]
      : undefined;
    const cleaned = host.store.reviews().some(review => review.runId === previousRun?.id && review.cleaned);
    const previous = cleaned || (executionMode === 'code' && previousRun?.workspace === project.root) ? undefined : previousRun?.workspace;
    const runId = randomUUID();
    const plan = () => conversation.kind === 'project-setup' ? project.root : plannedConversationWorkspace(project.root, conversation.id, previous);
    const planned = host.planWorkspace(project.root, { kind: 'run', id: runId, projectId: project.id, conversationId: conversation.id }, plan, held, executionMode === 'read-only');
    const workspace = planned.lease.access === 'read' || conversation.kind === 'project-setup' ? project.root : prepareWorkspace(project.root, conversation.id, previous);
    if (workspace !== planned.workspace) throw new Error('Conversation workspace changed during preparation.');
    planned.lease = host.ownership.bind(planned.lease);
    held.set(planned.lease.reservationId, planned.lease);
    if (executionMode === 'code') inspectGitWorkspace(project.root, workspace);
    host.reviews.invalidate(conversation.id);
    assertWorkspaceIdentity(project.root, rootIdentity);
    const run: Run = { harnessAuthorizationRevision: settings.revision, enabledHarnessRoutes: settings.enabledRoutes?.map(route => ({ ...route })) ?? (info.executable ? [{ harness: selection.harness, executable: info.executable }] : []), executionOrigin: host.executionOrigin, workspaceIdentity: workspaceIdentity(workspace), projectContext, harness: selection.harness, executable: info.executable, executableVersion: info.version, id: runId, projectId: project.id, conversationId: conversation.id, ...(recoveryMessages ? { recoveryMessages } : {}), status: 'starting', model: selection.model, effort: selection.effort, executionMode, settingsSource, memory, projectSettingsRevision: settings.revision, workspace, createdAt: now(), updatedAt: now(), lastActivityAt: now() };
    run.logsPath = join(host.store.runDirectory(run), 'logs');
    host.store.transaction(() => {
      host.store.putConversation({ ...conversation, title: conversation.title === 'New conversation' ? input.text.trim().slice(0, 64) : conversation.title, ...(explicit ? { harness: selection.harness, model: selection.model, effort: selection.effort } : {}), updatedAt: now() });
      host.store.putRun(run);
      host.store.putMessage({ id: randomUUID(), runId: run.id, conversationId: conversation.id, role: 'user', text: input.text, createdAt: now() });
      host.store.append(run, 'run.created', executionMode === 'code' ? 'Code conversation queued' : 'Read-only conversation queued', { harness: run.harness, model: run.model, effort: run.effort, settingsSource, projectSettingsRevision: settings.revision, nativeVersion: info.version ?? 'unknown', executable: run.executable, workspace, executionMode });
    });
    createdRun = run;
    try { host.memory.retain(project.id, run.id, memory); host.store.exportRun(run); }
    catch { host.finish(run, 'failed', 'Could not export run logs. No harness was launched.'); throw new Error('Could not export run logs.'); }
    if (workspace !== project.root) {
      try { host.checkpoints.capture(run, 'before-turn'); }
      catch (cause) { preparationFailure = cause; host.checkpoints.failed(run, cause); run.cleanupUnconfirmed = !workspaceCleanupConfirmed(cause); host.finish(run, 'failed', 'Could not retain the starting checkpoint. No harness was launched.'); throw cause; }
    } else {
      host.checkpoints.failed(run, new Error('File recovery is currently supported only for Git worktrees with a committed HEAD. This read-only folder run has retained history but no recoverable code checkpoint.'));
    }
    const controller = new AbortController();
    // Register ownership before asynchronous adapter startup; Stop can interrupt launch too.
    const state = { controller, done: Promise.resolve(), run };
    const lease = host.workspaces.transfer(planned, held);
    host.active.set(run.id, state);
    state.done = host.workspaces.observe(run, host.execute(run, controller, lease));
    host.changed();
    return { ...run };
  } catch (error) {
    if (workspaceCleanupConfirmed(preparationFailure)) preparationFailure = error;
    if (createdRun && !host.active.has(createdRun.id)) {
      createdRun.cleanupUnconfirmed ||= !workspaceCleanupConfirmed(preparationFailure);
      if (createdRun.status === 'starting') host.finish(createdRun, 'failed', 'Workspace preparation failed before native dispatch.');
      else host.store.putRun(createdRun);
    }
    throw error;
  } finally {
    try { host.workspaces.release(held, preparationFailure); } finally { host.admission.delete(conversation.id); prepared(); }
  }
}
