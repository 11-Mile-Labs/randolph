import { AppSettings, type AppSettingsSnapshot, type SaveAppSettingsInput, type SaveGlobalMemoryInput } from './app-settings.js';
import { randomUUID } from 'node:crypto';
import { basename, resolve, join } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { canonicalProject, prepareWorkspace } from './workspace.js';
import { readHarnessSettings, writeHarnessSettings } from './harness-settings.js';
import { inspectGitWorkspace } from './git-review.js';
import { ProjectMemory, type MemoryCommand, type MemorySnapshot, type PreparedMemory } from './memory.js';
import type { LessonRef, LessonVersion } from './lessons.js';
import { Integrations, type IntegrationState } from './integrations.js';
import { Pushes, type ApprovePushInput } from './pushes.js';
import type { PushOptions } from './push.js';
import { Reviews } from './reviews.js';
import { Checkpoints, type CheckpointInput, type CheckpointRestore } from './checkpoints.js';
import type { AdapterEvent, ApproveReviewInput, ChatEventsInput, ChatEventsResult, Conversation, ConversationModeInput, ConversationSelectionInput, HarnessAdapter, HarnessInfo, HarnessSelection, LinkedRunResult, Project, ProjectHarnessSettings, RerunCheckpointInput, RestartCheckpointInput, ReviewRecord, Run, SaveProjectDefaultsInput, SendInput, WorkspaceSnapshot } from './contracts.js';
export type * from './contracts.js';
export { Store } from './store.js';
const activeStatuses = new Set(['starting', 'running', 'stopping', 'stop-unconfirmed']);
const preDispatchRecoveryFailure = 'Linked checkpoint recovery failed before native dispatch. No harness was launched.';
const now = (): string => new Date().toISOString();
type RecoveryContext = {
  executable?: string; executableVersion?: string;
  model: string; effort: string; executionMode: NonNullable<Run['executionMode']>; settingsSource?: Run['settingsSource']; projectSettingsRevision?: string | null;
  memory?: PreparedMemory; messages: Array<{ role: 'user' | 'assistant'; text: string }>; title: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The retained checkpoint context is incomplete. Restore files to inspect it without execution.');
  return value as Record<string, unknown>;
}

function plainMessages(values: unknown[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  return values.map(value => {
    const message = object(value);
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string') throw new Error('The retained checkpoint contains invalid conversation context.');
    return { role: message.role, text: message.text };
  });
}

function recoveryContext(metadata: Record<string, unknown>, kind: 'restart' | 'rerun', sourceRunId: string): RecoveryContext {
  const savedRun = object(metadata.run);
  const savedConversation = object(metadata.conversation);
  if (savedRun.id !== sourceRunId || typeof savedRun.model !== 'string' || typeof savedRun.effort !== 'string' || (savedRun.executionMode !== 'code' && savedRun.executionMode !== 'read-only')) throw new Error('The retained checkpoint does not contain a compatible run configuration. Restore files to inspect it without execution.');
  let messages: RecoveryContext['messages'];
  if (savedRun.recoveryMessages !== undefined) {
    if (!Array.isArray(savedRun.recoveryMessages)) throw new Error('The retained checkpoint contains invalid recovery context.');
    messages = plainMessages(savedRun.recoveryMessages);
  } else {
    if (!Array.isArray(metadata.messages)) throw new Error('The retained checkpoint does not contain restart context. Restore files to inspect it without execution.');
    messages = metadata.messages.flatMap(value => {
      const message = object(value);
      if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string' || typeof message.id !== 'string' || typeof message.runId !== 'string') throw new Error('The retained checkpoint contains invalid conversation context.');
      const isSourceAnswer = kind === 'rerun' && message.role === 'assistant' && message.runId === sourceRunId && !message.id.startsWith(`${sourceRunId}:recovery:`);
      return isSourceAnswer ? [] : [{ role: message.role as 'user' | 'assistant', text: message.text }];
    });
  }
  if (!messages.length || typeof savedConversation.title !== 'string') throw new Error('The retained checkpoint does not contain restart context. Restore files to inspect it without execution.');
  const settingsSource = savedRun.settingsSource;
  if (settingsSource !== undefined && settingsSource !== 'project' && settingsSource !== 'conversation' && settingsSource !== 'native') throw new Error('The retained checkpoint contains invalid harness provenance.');
  const projectSettingsRevision = savedRun.projectSettingsRevision;
  if (projectSettingsRevision !== undefined && projectSettingsRevision !== null && typeof projectSettingsRevision !== 'string') throw new Error('The retained checkpoint contains invalid project settings provenance.');
  return {
    executable: typeof savedRun.executable === 'string' ? savedRun.executable : undefined,
    executableVersion: typeof savedRun.executableVersion === 'string' ? savedRun.executableVersion : undefined,
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

function assertReconciledExternalActions(metadata: Record<string, unknown>): void {
  if (!Array.isArray(metadata.externalActions)) throw new Error('The retained checkpoint lacks external-action reconciliation context. Restore files to inspect it without execution.');
  for (const value of metadata.externalActions) {
    const action = object(value);
    const push = action.push && typeof action.push === 'object' ? action.push as Record<string, unknown> : undefined;
    const result = push?.result && typeof push.result === 'object' ? push.result as Record<string, unknown> : undefined;
    if (action.originOperation === 'active' || action.originOperation === 'cleanup-unconfirmed' || action.status === 'delivering' || action.status === 'interrupted' || action.status === 'stop-unconfirmed' || push?.status === 'pushing' || push?.status === 'uncertain' || result?.cleanupVerified === false) throw new Error('Reconcile the retained external action and process cleanup before linked execution.');
  }
}
export class Runtime {
  readonly store: Store;
  private readonly preferences: AppSettings;
  private readonly reviews: Reviews;
  private readonly checkpoints: Checkpoints;
  private readonly pushes: Pushes;
  private readonly integrations: Integrations;
  private readonly memory: ProjectMemory;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; run: Run }>();
  private readonly listeners = new Set<() => void>();
  private accepting = true;
  private admission = new Set<string>();
  constructor(readonly adapter: HarnessAdapter, dataRoot: string, options: { push?: PushOptions } = {}) {
    this.store = new Store(resolve(dataRoot));
    this.preferences = new AppSettings(this.store.root);
    this.checkpoints = new Checkpoints(this.store);
    this.memory = new ProjectMemory(this.store, () => this.changed());
    for (const run of this.store.runs()) {
      if (activeStatuses.has(run.status)) {
        this.store.transaction(() => {
          run.status = 'interrupted'; run.cleanupUnconfirmed = true; run.updatedAt = now();
          run.error = 'The application ended during this run. It has not been restarted; previous process cleanup could not be verified.';
          this.store.putRun(run);
          this.store.append(run, 'run.interrupted', run.error);
        });
      }
      this.store.exportRun(run);
    }
    this.integrations = new Integrations(this.store, id => this.accepting && !this.admission.has(id) && !this.reviews.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed)), () => this.changed());
    this.pushes = new Pushes(this.store, id => this.accepting && !this.admission.has(id) && !this.reviews.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed)), () => this.changed(), options.push);
    this.reviews = new Reviews(this.store, adapter, id => !this.admission.has(id) && !this.pushes.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed)), () => this.changed());
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of this.listeners) listener(); }
  snapshot(): WorkspaceSnapshot {
    const snapshot = this.store.snapshot();
    return { ...snapshot, projects: snapshot.projects.map(project => ({ ...project, harnessSettings: readHarnessSettings(project.root) })) };
  }
  chatEvents(input: ChatEventsInput): ChatEventsResult {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) throw new Error('Invalid event cursor.');
    return this.store.chatEvents(input.conversationId, input.runId, input.afterSequence);
  }
  restoreCheckpoint(input: CheckpointInput, destination: string): CheckpointRestore {
    if (!this.accepting) throw new Error('Application is closing.');
    return this.checkpoints.restore(input, destination);
  }
  appSettings(): AppSettingsSnapshot { return this.preferences.read(); }
  saveAppSettings(input: SaveAppSettingsInput): AppSettingsSnapshot {
    if (!this.accepting) throw new Error('Application is closing.');
    const result = this.preferences.save(input); this.changed(); return result;
  }
  saveGlobalMemory(input: SaveGlobalMemoryInput): AppSettingsSnapshot {
    if (!this.accepting) throw new Error('Application is closing.');
    const result = this.preferences.saveGlobalMemory(input); this.changed(); return result;
  }
  restartRun(input: RestartCheckpointInput): Promise<LinkedRunResult> { return this.recoverFromCheckpoint('restart', input); }
  rerunFromCheckpoint(input: RerunCheckpointInput): Promise<LinkedRunResult> { return this.recoverFromCheckpoint('rerun', input); }
  memorySnapshot(projectId: string): MemorySnapshot { return this.memory.snapshot(projectId); }
  memoryHistory(projectId: string, reference: LessonRef): LessonVersion[] { return this.memory.history(projectId, reference); }
  memoryCommand(input: MemoryCommand): MemorySnapshot {
    if (!this.accepting) throw new Error('Application is closing.');
    return this.memory.command(input);
  }
  async harnessInstallations() { return this.adapter.installations ? await this.adapter.installations() : []; }
  private async inspectExecutable(executable?: string | null): Promise<HarnessInfo> {
    if (executable && !(await this.harnessInstallations()).some(item => item.executable === executable)) throw new Error('The selected CLI is no longer discovered. Choose an installed CLI in Project settings.');
    return this.adapter.discover(executable ?? undefined);
  }
  async harness(projectId?: string, executable?: string): Promise<HarnessInfo> {
    if (executable) return this.inspectExecutable(executable);
    if (!projectId) return this.adapter.discover();
    const settings = readHarnessSettings(this.project(projectId).root);
    if (settings.error) return { available: false, authenticated: false, models: [], reason: settings.error };
    try { return await this.inspectExecutable(settings.defaults?.executable); }
    catch (cause) { return { available: false, authenticated: false, models: [], reason: cause instanceof Error ? cause.message : 'CLI discovery failed.' }; }
  }
  async setExecutionMode(input: ConversationModeInput): Promise<Conversation> {
    if (!this.accepting) throw new Error('Application is closing.');
    if (input.executionMode !== 'read-only' && input.executionMode !== 'code') throw new Error('Invalid execution mode.');
    this.conversation(input.conversationId);
    if (input.executionMode === 'code') {
      const info = await this.harness(this.conversation(input.conversationId).projectId);
      if (!this.accepting) throw new Error('Application is closing.');
      if (!info.authenticated || !info.executionModes?.includes('code')) throw new Error('Code mode is not verified for this installed harness.');
    }
    if (this.admission.has(input.conversationId) || this.reviews.hasActiveWork(input.conversationId) || this.store.runs().some(run => run.conversationId === input.conversationId && (activeStatuses.has(run.status) || run.cleanupUnconfirmed))) throw new Error('Wait for active work to finish before changing execution mode.');
    const conversation = { ...this.conversation(input.conversationId), executionMode: input.executionMode, updatedAt: now() };
    this.store.putConversation(conversation); this.changed(); return conversation;
  }
  integrateConversation(conversationId: string): IntegrationState | null { return this.integrations.update(conversationId); }
  confirmIntegration(conversationId: string): IntegrationState { return this.integrations.confirmResolved(conversationId); }
  prepareReview(conversationId: string): ReviewRecord {
    this.integrations.update(conversationId);
    this.integrations.assertReviewable(conversationId);
    return this.reviews.prepare(conversationId);
  }
  verifyReview(reviewId: string): Promise<ReviewRecord> { return this.reviews.verify(reviewId); }
  approveReview(input: ApproveReviewInput): Promise<ReviewRecord> { return this.reviews.approve(input); }
  previewPush(reviewId: string): Promise<ReviewRecord> { return this.pushes.preview(reviewId); }
  approvePush(input: ApprovePushInput): Promise<ReviewRecord> { return this.pushes.approve(input); }
  checkPush(reviewId: string): Promise<ReviewRecord> { return this.pushes.check(reviewId); }
  stopPush(reviewId: string): Promise<void> { return this.pushes.stop(reviewId); }
  stopReview(reviewId: string): Promise<void> { return this.reviews.stop(reviewId); }
  private project(id: string): Project {
    const project = this.store.projects().find(value => value.id === id);
    if (!project) throw new Error('Project does not exist.');
    return project;
  }
  private validateSelection(selection: HarnessSelection, info: HarnessInfo): void {
    if (!info.available || !info.authenticated) throw new Error(info.reason ?? 'Sign into the installed Codex CLI with ChatGPT first.');
    const model = info.models.find(candidate => candidate.id === selection.model);
    if (selection.harness !== 'codex' || !model || !model.efforts.includes(selection.effort)) throw new Error('Choose an available model and effort.');
  }
  async saveProjectDefaults(input: SaveProjectDefaultsInput): Promise<ProjectHarnessSettings> {
    if (!this.accepting) throw new Error('Application is closing.');
    const project = this.project(input.projectId);
    const info = await this.inspectExecutable(input.defaults.executable);
    if (!this.accepting) throw new Error('Application is closing.');
    this.validateSelection(input.defaults, info);
    const settings = writeHarnessSettings(project.root, input.defaults, input.expectedRevision);
    this.changed();
    return settings;
  }
  async setConversationSelection(input: ConversationSelectionInput): Promise<Conversation> {
    if (!this.accepting) throw new Error('Application is closing.');
    this.conversation(input.conversationId);
    if (input.selection) {
      const info = await this.harness(this.conversation(input.conversationId).projectId);
      if (!this.accepting) throw new Error('Application is closing.');
      this.validateSelection(input.selection, info);
    }
    const conversation = { ...this.conversation(input.conversationId), model: input.selection?.model ?? '', effort: input.selection?.effort ?? '', updatedAt: now() };
    this.store.putConversation(conversation); this.changed();
    return conversation;
  }
  addProject(path: string): Project {
    if (!this.accepting) throw new Error('Application is closing.');
    if (!statSync(path).isDirectory()) throw new Error('Choose a project folder.');
    const root = canonicalProject(path);
    const existing = this.store.projects().find(project => project.root === root);
    if (existing) return existing;
    const project = { id: randomUUID(), name: basename(root), root, createdAt: now() };
    this.store.putProject(project); this.changed(); return project;
  }
  createConversation(projectId: string): Conversation {
    if (!this.accepting) throw new Error('Application is closing.');
    if (!this.store.projects().some(project => project.id === projectId)) throw new Error('Project does not exist.');
    const conversation: Conversation = { id: randomUUID(), projectId, title: 'New conversation', model: '', effort: '', createdAt: now(), updatedAt: now(), lastReadSequence: 0 };
    this.store.putConversation(conversation); this.changed(); return conversation;
  }
  markRead(conversationId: string): void {
    const conversation = this.conversation(conversationId);
    const sequence = this.store.events().filter(event => event.conversationId === conversationId).at(-1)?.sequence ?? 0;
    if (sequence <= conversation.lastReadSequence) return;
    this.store.putConversation({ ...conversation, lastReadSequence: sequence }); this.changed();
  }
  private conversation(id: string): Conversation {
    const conversation = this.store.conversations().find(value => value.id === id);
    if (!conversation) throw new Error('Conversation does not exist.');
    return conversation;
  }
  private async recoverFromCheckpoint(kind: 'restart' | 'rerun', input: RestartCheckpointInput | RerunCheckpointInput): Promise<LinkedRunResult> {
    if (!this.accepting) throw new Error('Application is closing.');
    const selected = this.checkpoints.selected(input.runId, input.checkpointDigest);
    const sourceRun = selected.run;
    const sourceConversation = this.conversation(sourceRun.conversationId);
    if (kind === 'restart') {
      if (sourceRun.status !== 'interrupted') throw new Error('Only stopped or interrupted work can be restarted. Use rerun for a completed result.');
      const sourceRuns = this.store.runs().filter(run => run.conversationId === sourceConversation.id);
      const sourceIndex = sourceRuns.findIndex(run => run.id === sourceRun.id);
      const laterRunBlocksRetry = sourceRuns.slice(sourceIndex + 1).some(run => run.recoveryKind !== 'restart' || run.sourceRunId !== sourceRun.id || run.sourceCheckpointDigest !== selected.checkpoint.digest || run.status !== 'failed' || run.error !== preDispatchRecoveryFailure);
      if (laterRunBlocksRetry) throw new Error('Restart applies only to the latest run in this conversation; a newer run already exists.');
      if (sourceRun.checkpoints?.at(-1)?.digest !== selected.checkpoint.digest) throw new Error('Restart requires the last safe completed checkpoint; partial work is never recovered silently.');
    } else if (!['completed', 'failed', 'interrupted'].includes(sourceRun.status)) {
      throw new Error('Rerun requires a retained checkpoint from completed, failed, or interrupted work.');
    }
    if (this.admission.has(sourceConversation.id) || this.reviews.hasActiveWork(sourceConversation.id) || this.pushes.hasActiveWork(sourceConversation.id) || this.store.runs().some(run => run.conversationId === sourceConversation.id && activeStatuses.has(run.status))) throw new Error('Wait for active source-conversation work to finish before linked execution.');
    if (this.store.runs().some(run => run.conversationId === sourceConversation.id && run.cleanupUnconfirmed) || this.store.reviews().some(review => review.conversationId === sourceConversation.id && (review.originOperation === 'cleanup-unconfirmed' || review.push?.result?.cleanupVerified === false))) throw new Error('Reconcile process cleanup before linked execution.');
    if (this.store.reviews().some(review => review.conversationId === sourceConversation.id && review.deliveryPlan && review.status !== 'delivered' && review.status !== 'stale')) throw new Error('Reconcile the prior delivery outcome before linked execution; approved effects are never replayed.');
    if (this.integrations.blocksNewWork(sourceConversation.id)) throw new Error('Finish interrupted parent integration before linked execution.');
    assertReconciledExternalActions(selected.manifest.metadata);
    const context = recoveryContext(selected.manifest.metadata, kind, sourceRun.id);
    this.admission.add(sourceConversation.id);
    let targetConversationId: string | undefined;
    let run: Run | undefined;
    try {
      const info = context.executable ? await this.adapter.discover(context.executable) : await this.harness(sourceRun.projectId);
      if (context.executableVersion && info.version !== context.executableVersion) throw new Error('The checkpoint CLI version changed. Restore files to inspect it; this checkpoint cannot silently switch executables.');
      if (!this.accepting) throw new Error('Application is closing.');
      this.validateSelection({ harness: 'codex', model: context.model, effort: context.effort }, info);
      if (context.executionMode === 'code' && !info.executionModes?.includes('code')) throw new Error('Code mode is not verified for this installed harness.');
      const project = this.project(sourceRun.projectId);
      const createdAt = now();
      const runId = randomUUID();
      const targetConversation: Conversation = kind === 'restart'
        ? { ...this.conversation(sourceConversation.id), model: context.model, effort: context.effort, executionMode: context.executionMode, updatedAt: createdAt }
        : { id: randomUUID(), projectId: project.id, sourceConversationId: sourceConversation.id, title: `Rerun: ${context.title}`, model: context.model, effort: context.effort, executionMode: context.executionMode, createdAt, updatedAt: createdAt, lastReadSequence: 0 };
      targetConversationId = targetConversation.id;
      if (targetConversation.id !== sourceConversation.id) this.admission.add(targetConversation.id);
      const workspace = join(project.root, '.worktrees', `randolph-${runId}`);
      run = {
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
      run.logsPath = join(this.store.runDirectory(run), 'logs');
      this.store.transaction(() => {
        this.store.putConversation(targetConversation);
        this.store.putRun(run!);
        if (kind === 'rerun') for (const [index, message] of context.messages.entries()) this.store.putMessage({ ...message, id: `${runId}:recovery:${index}`, runId, conversationId: targetConversation.id, createdAt });
        this.store.append(run!, kind === 'restart' ? 'run.restart-requested' : 'run.rerun-requested', kind === 'restart' ? 'Explicit restart requested from the last safe checkpoint' : 'Explicit rerun requested in a linked conversation', { sourceRunId: sourceRun.id, sourceConversationId: sourceConversation.id, checkpointDigest: selected.checkpoint.digest, workspace });
      });
      try {
        if (context.memory) this.memory.retain(project.id, run.id, context.memory);
        this.store.exportRun(run);
        const restored = this.checkpoints.restoreWorktree(sourceRun.id, selected.checkpoint.digest, project.root, run.id);
        if (restored.workspace !== run.workspace) throw new Error('Linked checkpoint restored to an unexpected workspace.');
        if (kind === 'restart') this.reviews.invalidate(sourceConversation.id);
        this.checkpoints.capture(run, 'before-turn');
      } catch (cause) {
        this.checkpoints.failed(run, cause);
        this.finish(run, 'failed', preDispatchRecoveryFailure);
        throw cause;
      }
      const controller = new AbortController();
      const state = { controller, done: Promise.resolve(), run };
      this.active.set(run.id, state);
      state.done = this.execute(run, controller);
      this.changed();
      return { conversation: targetConversation, run: { ...run } };
    } finally {
      this.admission.delete(sourceConversation.id);
      if (targetConversationId) this.admission.delete(targetConversationId);
    }
  }
  async send(input: SendInput): Promise<Run> {
    if (!this.accepting) throw new Error('Application is closing.');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64_000) throw new Error('Enter a message of at most 64,000 characters.');
    let conversation = this.conversation(input.conversationId);
    if (this.admission.has(conversation.id) || this.reviews.hasActiveWork(conversation.id) || this.pushes.hasActiveWork(conversation.id) || this.store.runs().some(run => run.conversationId === conversation.id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed))) throw new Error('This conversation already has active work.');
    if (this.integrations.blocksNewWork(conversation.id)) throw new Error('Finish interrupted parent integration before starting new work.');
    this.admission.add(conversation.id);
    try {
      const project = this.project(conversation.projectId);
      const settings = readHarnessSettings(project.root);
      if (settings.error) throw new Error(settings.error);
      const info = await this.inspectExecutable(settings.defaults?.executable);
      if (!this.accepting) throw new Error('Application is closing.');
      conversation = this.conversation(input.conversationId);
      if (readHarnessSettings(project.root).revision !== settings.revision) throw new Error('Project harness settings changed during discovery. Try again.');
      const explicit = input.model !== undefined || input.effort !== undefined;
      const override = explicit || Boolean(conversation.model || conversation.effort);
      const selection: HarnessSelection = override
        ? { harness: 'codex', model: explicit ? input.model ?? '' : conversation.model, effort: explicit ? input.effort ?? '' : conversation.effort }
        : settings.defaults ?? { harness: 'codex', model: info.models[0]?.id ?? '', effort: info.models[0]?.defaultEffort ?? '' };
      this.validateSelection(selection, info);
      const memory = this.memory.prepare(project.id, input.text);
      const settingsSource = override ? 'conversation' : settings.defaults ? 'project' : 'native';
      const executionMode = conversation.executionMode ?? 'read-only';
      if (executionMode === 'code' && !info.executionModes?.includes('code')) throw new Error('Code mode is not verified for this installed harness.');
      const previousRun = this.store.runs().findLast(run => run.conversationId === conversation.id);
      const recoveryMessages = previousRun?.recoveryMessages
        ? [
            ...previousRun.recoveryMessages.map(message => ({ ...message })),
            ...this.store.messages(conversation.id).filter(message => message.runId === previousRun.id && !message.id.startsWith(`${previousRun.id}:recovery:`)).map(({ role, text }) => ({ role, text })),
            { role: 'user' as const, text: input.text },
          ]
        : undefined;
      const cleaned = this.store.reviews().some(review => review.runId === previousRun?.id && review.cleaned);
      const previous = cleaned || (executionMode === 'code' && previousRun?.workspace === project.root) ? undefined : previousRun?.workspace;
      const workspace = prepareWorkspace(project.root, conversation.id, previous);
      if (executionMode === 'code') inspectGitWorkspace(project.root, workspace);
      this.reviews.invalidate(conversation.id);
      const run: Run = { executable: info.executable, executableVersion: info.version, id: randomUUID(), projectId: project.id, conversationId: conversation.id, ...(recoveryMessages ? { recoveryMessages } : {}), status: 'starting', model: selection.model, effort: selection.effort, executionMode, settingsSource, memory, projectSettingsRevision: settings.revision, workspace, createdAt: now(), updatedAt: now(), lastActivityAt: now() };
      run.logsPath = join(this.store.runDirectory(run), 'logs');
      this.store.transaction(() => {
        this.store.putConversation({ ...conversation, title: conversation.title === 'New conversation' ? input.text.trim().slice(0, 64) : conversation.title, ...(explicit ? { model: selection.model, effort: selection.effort } : {}), updatedAt: now() });
        this.store.putRun(run);
        this.store.putMessage({ id: randomUUID(), runId: run.id, conversationId: conversation.id, role: 'user', text: input.text, createdAt: now() });
        this.store.append(run, 'run.created', executionMode === 'code' ? 'Code conversation queued' : 'Read-only conversation queued', { model: run.model, effort: run.effort, settingsSource, projectSettingsRevision: settings.revision, nativeVersion: info.version ?? 'unknown', workspace, executionMode });
      });
      try { this.memory.retain(project.id, run.id, memory); this.store.exportRun(run); }
      catch { this.finish(run, 'failed', 'Could not export run logs. No harness was launched.'); throw new Error('Could not export run logs.'); }
      if (workspace !== project.root) {
        try { this.checkpoints.capture(run, 'before-turn'); }
        catch (cause) { this.checkpoints.failed(run, cause); this.finish(run, 'failed', 'Could not retain the starting checkpoint. No harness was launched.'); throw cause; }
      } else {
        this.checkpoints.failed(run, new Error('File recovery is currently supported only for Git worktrees with a committed HEAD. This read-only folder run has retained history but no recoverable code checkpoint.'));
      }
      const controller = new AbortController();
      // Register ownership before asynchronous adapter startup; Stop can interrupt launch too.
      const state = { controller, done: Promise.resolve(), run };
      this.active.set(run.id, state);
      state.done = this.execute(run, controller);
      this.changed();
      return { ...run };
    } finally { this.admission.delete(conversation.id); }
  }
  private async execute(run: Run, controller: AbortController): Promise<void> {
    try {
      this.event(run, { type: 'run.started', summary: 'Connecting to Codex' });
      const messages = run.recoveryMessages?.map(message => ({ ...message })) ?? this.store.messages(run.conversationId).map(({ role, text }) => ({ role, text }));
      if (run.memory?.text) messages.unshift({ role: 'user', text: run.memory.text });
      const result = await this.adapter.run({ executable: run.executable, executableVersion: run.executableVersion, workspace: run.workspace, model: run.model, effort: run.effort, executionMode: run.executionMode, messages, signal: controller.signal, onEvent: event => this.event(run, event) });
      this.finish(run, result.status, result.status === 'stop-unconfirmed' ? 'The harness stopped responding; cleanup could not be confirmed.' : undefined);
      if (result.status === 'completed' && run.checkpoints?.length) {
        try { this.checkpoints.capture(run, 'completed-turn'); }
        catch (cause) { this.checkpoints.failed(run, cause); }
      }
    } catch (error) {
      this.finish(run, 'failed', error instanceof Error ? error.message : 'Harness failed.');
    } finally { this.active.delete(run.id); this.changed(); }
  }
  private event(run: Run, event: AdapterEvent): void {
    if (!this.active.has(run.id)) return;
    this.store.transaction(() => {
      run.updatedAt = now(); run.lastActivityAt = now();
      if (run.status === 'starting') run.status = 'running';
      this.store.putRun(run);
      this.store.append(run, event.type, event.summary, event.data);
      if (event.type === 'message.delta' && typeof event.data?.text === 'string' && typeof event.data?.messageId === 'string') {
        const id = `${run.id}:${event.data.messageId}`;
        const existing = this.store.message(id);
        this.store.putMessage({ id, runId: run.id, conversationId: run.conversationId, role: 'assistant', text: (existing?.text ?? '') + event.data.text, createdAt: existing?.createdAt ?? now() });
      }
    });
    this.store.exportRun(run); this.changed();
  }
  private finish(run: Run, status: Run['status'], error?: string): void {
    run.status = status; run.updatedAt = now(); run.error = error;
    this.store.transaction(() => { this.store.putRun(run); this.store.append(run, `run.${status}`, error ?? `Run ${status}`); });
    try { this.store.exportRun(run); } catch { /* SQLite remains authoritative; logs are repaired when reopened. */ }
  }
  async stop(runId: string): Promise<void> {
    const state = this.active.get(runId);
    if (!state) return;
    const run = state.run;
    run.status = 'stopping'; run.updatedAt = now();
    this.store.transaction(() => { this.store.putRun(run); this.store.append(run, 'run.stopping', 'Stopping Codex; awaiting confirmation'); });
    this.changed(); state.controller.abort(); await state.done;
  }
  hasActiveWork(): boolean { return this.active.size > 0 || this.admission.size > 0 || this.reviews.hasActiveWork() || this.pushes.hasActiveWork(); }
  async stopAll(): Promise<void> {
    await this.pushes.stopAll();
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    await Promise.all(this.store.reviews().filter(review => review.status === 'checking').map(review => this.reviews.stop(review.id)));
  }
  async close(): Promise<void> {
    this.accepting = false;
    await this.pushes.close();
    await this.reviews.close();
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    // In-flight discovery cannot dispatch after accepting=false; it does not access storage again.
    this.store.close();
  }
}
