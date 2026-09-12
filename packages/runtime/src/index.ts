import { randomUUID } from 'node:crypto';
import { basename, resolve, join } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { canonicalProject, prepareWorkspace } from './workspace.js';
import { readHarnessSettings, writeHarnessSettings } from './harness-settings.js';
import type { AdapterEvent, Conversation, ConversationSelectionInput, HarnessAdapter, HarnessInfo, HarnessSelection, Project, ProjectHarnessSettings, Run, SaveProjectDefaultsInput, SendInput, WorkspaceSnapshot } from './contracts.js';
export type * from './contracts.js';
export { Store } from './store.js';
const activeStatuses = new Set(['starting', 'running', 'stopping', 'stop-unconfirmed']);
const now = (): string => new Date().toISOString();
export class Runtime {
  readonly store: Store;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; run: Run }>();
  private readonly listeners = new Set<() => void>();
  private accepting = true;
  private admission = new Set<string>();
  constructor(readonly adapter: HarnessAdapter, dataRoot: string) {
    this.store = new Store(resolve(dataRoot));
    for (const run of this.store.runs()) {
      if (activeStatuses.has(run.status)) {
        this.store.transaction(() => {
          run.status = 'interrupted'; run.updatedAt = now();
          run.error = 'The application ended during this run. It has not been restarted; previous process cleanup could not be verified.';
          this.store.putRun(run);
          this.store.append(run, 'run.interrupted', run.error);
        });
      }
      this.store.exportRun(run);
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of this.listeners) listener(); }
  snapshot(): WorkspaceSnapshot {
    const snapshot = this.store.snapshot();
    return { ...snapshot, projects: snapshot.projects.map(project => ({ ...project, harnessSettings: readHarnessSettings(project.root) })) };
  }
  harness(): Promise<HarnessInfo> { return this.adapter.discover(); }
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
    if (this.admission.has(conversation.id) || this.store.runs().some(run => run.conversationId === conversation.id && activeStatuses.has(run.status))) throw new Error('This conversation already has active work.');
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
      const settingsSource = override ? 'conversation' : settings.defaults ? 'project' : 'native';
      const previous = this.store.runs().find(run => run.conversationId === conversation.id)?.workspace;
      const workspace = prepareWorkspace(project.root, conversation.id, previous);
      const run: Run = { id: randomUUID(), projectId: project.id, conversationId: conversation.id, status: 'starting', model: selection.model, effort: selection.effort, settingsSource, projectSettingsRevision: settings.revision, workspace, createdAt: now(), updatedAt: now(), lastActivityAt: now() };
      run.logsPath = join(this.store.runDirectory(run), 'logs');
      this.store.transaction(() => {
        this.store.putConversation({ ...conversation, title: conversation.title === 'New conversation' ? input.text.trim().slice(0, 64) : conversation.title, ...(explicit ? { model: selection.model, effort: selection.effort } : {}), updatedAt: now() });
        this.store.putRun(run);
        this.store.putMessage({ id: randomUUID(), runId: run.id, conversationId: conversation.id, role: 'user', text: input.text, createdAt: now() });
        this.store.append(run, 'run.created', 'Read-only conversation queued', { model: run.model, effort: run.effort, settingsSource, projectSettingsRevision: settings.revision, nativeVersion: info.version ?? 'unknown', workspace, executionMode: 'read-only' });
      });
      try { this.store.exportRun(run); }
      catch { this.finish(run, 'failed', 'Could not export run logs. No harness was launched.'); throw new Error('Could not export run logs.'); }
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
      const result = await this.adapter.run({ workspace: run.workspace, model: run.model, effort: run.effort, messages, signal: controller.signal, onEvent: event => this.event(run, event) });
      this.finish(run, result.status, result.status === 'stop-unconfirmed' ? 'The harness stopped responding; cleanup could not be confirmed.' : undefined);
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
  hasActiveWork(): boolean { return this.active.size > 0 || this.admission.size > 0; }
  async close(): Promise<void> {
    this.accepting = false;
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    // In-flight discovery cannot dispatch after accepting=false; it does not access storage again.
    this.store.close();
  }
}
