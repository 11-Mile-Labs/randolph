import { randomUUID } from 'node:crypto';
import { basename, resolve, join } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { canonicalProject, prepareWorkspace } from './workspace.js';
import { readHarnessSettings, writeHarnessSettings } from './harness-settings.js';
import { inspectGitWorkspace } from './git-review.js';
import { ProjectMemory, type MemoryCommand, type MemorySnapshot } from './memory.js';
import type { LessonRef, LessonVersion } from './lessons.js';
import { Integrations, type IntegrationState } from './integrations.js';
import { Pushes, type ApprovePushInput } from './pushes.js';
import type { PushOptions } from './push.js';
import { Reviews } from './reviews.js';
import { Checkpoints, type CheckpointInput, type CheckpointRestore } from './checkpoints.js';
import type { AdapterEvent, ApproveReviewInput, Conversation, ConversationModeInput, ConversationSelectionInput, HarnessAdapter, HarnessInfo, HarnessSelection, Project, ProjectHarnessSettings, ReviewRecord, Run, SaveProjectDefaultsInput, SendInput, WorkspaceSnapshot } from './contracts.js';
export type * from './contracts.js';
export { Store } from './store.js';
const activeStatuses = new Set(['starting', 'running', 'stopping', 'stop-unconfirmed']);
const now = (): string => new Date().toISOString();
export class Runtime {
  readonly store: Store;
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
  restoreCheckpoint(input: CheckpointInput, destination: string): CheckpointRestore {
    if (!this.accepting) throw new Error('Application is closing.');
    return this.checkpoints.restore(input, destination);
  }
  memorySnapshot(projectId: string): MemorySnapshot { return this.memory.snapshot(projectId); }
  memoryHistory(projectId: string, reference: LessonRef): LessonVersion[] { return this.memory.history(projectId, reference); }
  memoryCommand(input: MemoryCommand): MemorySnapshot {
    if (!this.accepting) throw new Error('Application is closing.');
    return this.memory.command(input);
  }
  harness(): Promise<HarnessInfo> { return this.adapter.discover(); }
  async setExecutionMode(input: ConversationModeInput): Promise<Conversation> {
    if (!this.accepting) throw new Error('Application is closing.');
    if (input.executionMode !== 'read-only' && input.executionMode !== 'code') throw new Error('Invalid execution mode.');
    this.conversation(input.conversationId);
    if (input.executionMode === 'code') {
      const info = await this.harness();
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
    const info = await this.harness();
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
      const info = await this.harness();
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
  async send(input: SendInput): Promise<Run> {
    if (!this.accepting) throw new Error('Application is closing.');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64_000) throw new Error('Enter a message of at most 64,000 characters.');
    let conversation = this.conversation(input.conversationId);
    if (this.admission.has(conversation.id) || this.reviews.hasActiveWork(conversation.id) || this.pushes.hasActiveWork(conversation.id) || this.store.runs().some(run => run.conversationId === conversation.id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed))) throw new Error('This conversation already has active work.');
    if (this.integrations.blocksNewWork(conversation.id)) throw new Error('Finish interrupted parent integration before starting new work.');
    this.admission.add(conversation.id);
    try {
      const info = await this.harness();
      if (!this.accepting) throw new Error('Application is closing.');
      conversation = this.conversation(input.conversationId);
      const project = this.project(conversation.projectId);
      const settings = readHarnessSettings(project.root);
      if (settings.error) throw new Error(settings.error);
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
      const cleaned = this.store.reviews().some(review => review.runId === previousRun?.id && review.cleaned);
      const previous = cleaned || (executionMode === 'code' && previousRun?.workspace === project.root) ? undefined : previousRun?.workspace;
      const workspace = prepareWorkspace(project.root, conversation.id, previous);
      if (executionMode === 'code') inspectGitWorkspace(project.root, workspace);
      this.reviews.invalidate(conversation.id);
      const run: Run = { id: randomUUID(), projectId: project.id, conversationId: conversation.id, status: 'starting', model: selection.model, effort: selection.effort, executionMode, settingsSource, memory, projectSettingsRevision: settings.revision, workspace, createdAt: now(), updatedAt: now(), lastActivityAt: now() };
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
      const messages = this.store.snapshot().messages.filter(message => message.conversationId === run.conversationId).map(({ role, text }) => ({ role, text }));
      if (run.memory?.text) messages.unshift({ role: 'user', text: run.memory.text });
      const result = await this.adapter.run({ workspace: run.workspace, model: run.model, effort: run.effort, executionMode: run.executionMode, messages, signal: controller.signal, onEvent: event => this.event(run, event) });
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
