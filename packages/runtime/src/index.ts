import { assertWorkspaceIdentity, workspaceIdentity } from './workspace-identity.js';
import { cleanupReconciliationReason, readExecutionOrigin, type ExecutionOrigin } from './execution-origin.js';
import { parseSetupProposal, setupPrompt } from './project-setup.js';
import { readProjectContext, writeProjectContext, parseProjectContext, type ProjectContextSnapshot } from './project-context.js';
import { AppSettings, type AppSettingsSnapshot, type SaveAppSettingsInput, type SaveGlobalMemoryInput } from './app-settings.js';
import { randomUUID } from 'node:crypto';
import { basename, resolve, join } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { reconstructLegacyWorkspaceOwnership } from './workspace-recovery.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceLease, WorkspaceProvenance } from './workspace-leases.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { RunWorkspace } from './run-workspace.js';
import { recoverLinkedCheckpoint, type RecoveryHost } from './checkpoint-recovery.js';
import { NativeAdmission } from './native-admission.js';
import { canonicalProject, prepareWorkspace, plannedConversationWorkspace } from './workspace.js';
import { assertHarnessRoute, readHarnessSettings, writeHarnessSettings } from './harness-settings.js';
import { inspectGitWorkspace } from './git-review.js';
import { ProjectMemory, type MemoryCommand, type MemorySnapshot } from './memory.js';
import type { LessonRef, LessonVersion } from './lessons.js';
import { Integrations, type IntegrationState } from './integrations.js';
import { Pushes, type ApprovePushInput } from './pushes.js';
import type { PushOptions } from './push.js';
import { Reviews } from './reviews.js';
import { Checkpoints, type CheckpointInput, type CheckpointRestore } from './checkpoints.js';
import { DelegationCommands } from './delegation-commands.js';
import { runExecutionSnapshot } from './run-execution.js';
import { DelegationControls } from './delegation-control.js';
import { DelegationTasks } from './delegation-tasks.js';
import { DelegationChecks } from './delegation-checks.js';
import { assertDelegationBasis } from './delegation-basis.js';
import type { DelegationAvailability } from './delegation-plan.js';
import type { DelegationSnapshot, DelegationRevisionInput, ReviseDelegationInput, SaveDelegationPresetInput } from './delegation-contracts.js';
import { AdapterRunFailure } from './contracts.js';
import type { ApproveProjectSetupInput, InspectProjectInput, ProjectSetupSnapshot, AdapterEvent, ApproveReviewInput, ChatEventsInput, ChatEventsResult, Conversation, ConversationModeInput, ConversationSelectionInput, HarnessAdapter, HarnessId, HarnessInfo, HarnessInstallation, HarnessSelection, LinkedRunResult, Project, ProjectHarnessSettings, RerunCheckpointInput, RestartCheckpointInput, ReviewRecord, Run, SaveProjectDefaultsInput, SendInput, WorkspaceSnapshot } from './contracts.js';
export type * from './contracts.js';
export { Store } from './store.js';
const activeStatuses = new Set(['starting', 'running', 'stopping', 'stop-unconfirmed']);
const now = (): string => new Date().toISOString();
export class Runtime {
  readonly store: Store;
  private readonly nativeAdmission: NativeAdmission;
  private readonly workspaceOwnership: WorkspaceOwnership;
  private readonly workspaces: RunWorkspace;
  readonly adapter?: HarnessAdapter;
  private readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  private readonly preferences: AppSettings;
  private readonly reviews: Reviews;
  private readonly checkpoints: Checkpoints;
  private readonly pushes: Pushes;
  private readonly integrations: Integrations;
  private readonly memory: ProjectMemory;
  private readonly delegation: DelegationCommands;
  private readonly delegationControls: DelegationControls;
  private readonly executionOrigin: ExecutionOrigin | undefined;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void>; run: Run }>();
  private readonly listeners = new Set<() => void>();
  private accepting = true;
  private admission = new Set<string>();
  private setupAdmission = new Set<string>();
  constructor(adapter: HarnessAdapter | Partial<Record<HarnessId, HarnessAdapter>>, dataRoot: string, options: { push?: PushOptions; executionOrigin?: () => ExecutionOrigin | undefined } = {}) {
    this.executionOrigin = (options.executionOrigin ?? readExecutionOrigin)();
    this.adapters = 'discover' in adapter ? { codex: adapter } : adapter;
    this.adapter = this.adapters.codex;
    this.store = new Store(resolve(dataRoot));
    this.workspaceOwnership = new WorkspaceOwnership(this.store, this.executionOrigin);
    this.workspaces = new RunWorkspace(this.store, this.workspaceOwnership, (run, status, error) => this.finish(run, status, error));
    this.workspaceOwnership.reconcileOnReopen();
    reconstructLegacyWorkspaceOwnership(this.store, this.workspaceOwnership);
    this.nativeAdmission = new NativeAdmission(this.store, this.executionOrigin ?? {}, undefined, () => this.changed());
    this.preferences = new AppSettings(this.store.root);
    this.checkpoints = new Checkpoints(this.store);
    this.memory = new ProjectMemory(this.store, () => this.changed());
    this.delegation = new DelegationCommands(this.store, {
      assertMutable: run => {
        if (!this.accepting || this.admission.has(run.conversationId) || this.active.has(run.id) || this.reviews?.hasActiveWork(run.conversationId) || this.pushes?.hasActiveWork(run.conversationId)) throw new Error('Wait for current work to settle before changing this proposal.');
        const runs = this.store.runs().filter(candidate => candidate.conversationId === run.conversationId);
        if (runs.at(-1)?.id !== run.id) throw new Error('A newer conversation request superseded this proposal.');
        if (runs.some(candidate => activeStatuses.has(candidate.status) || candidate.cleanupUnconfirmed) || this.delegation.records.sessions(run.id).some(session => ['prepared', 'dispatch-intent', 'running', 'cleanup-unconfirmed'].includes(session.state))) throw new Error('Native work and cleanup must settle before a proposal decision.');
      },
      assertBasis: (run, plan) => assertDelegationBasis(this.store, run, plan),
      availability: async (run, plan) => {
        const routes: DelegationAvailability['routes'] = [];
        const unique = [...new Map(plan.plan.assignments.map(assignment => [`${assignment.harness}:${assignment.executable}`, assignment])).values()];
        const results = await Promise.allSettled(unique.map(async assignment => {
          if (!run.enabledHarnessRoutes?.some(route => route.harness === assignment.harness && route.executable === assignment.executable)) return;
          const adapter = this.adapters[assignment.harness];
          if (!adapter) return;
          const info = await this.nativeAdmission.adapter(assignment.harness, adapter, { owner: { kind: 'delegation', id: run.id }, runId: run.id }).discover(assignment.executable);
          if (!info.available || !info.authenticated || info.executable !== assignment.executable || !info.version) return;
          routes.push({ harness: assignment.harness, executable: info.executable, version: info.version, models: info.models.map(model => ({ id: model.id, efforts: model.efforts })), modes: info.executionModes ?? ['read-only'], enabled: true, commandCapability: Boolean(adapter.runCommand && info.commandLifecycle === true && info.executionModes?.includes('code')) });
        }));
        if (results.some(result => result.status === 'rejected')) throw new Error('A proposed CLI could not be inspected. Refresh before approval.');
        if (!run.executable || !run.executableVersion) throw new Error('The retained main-agent CLI identity is incomplete.');
        return { routes, mainSelection: { harness: run.harness ?? 'codex', executable: run.executable, executableVersion: run.executableVersion, model: run.model, effort: run.effort } };
      },
    }, () => this.changed());
    this.delegation.records.reconcileUnfinishedSessions();
    this.delegationControls = new DelegationControls(this.store);
    this.delegationControls.reconcileOnReopen();
    new DelegationChecks(this.store).reconcileOnReopen();
    new DelegationTasks(this.store).reconcileOnReopen();
    for (const run of this.store.runs()) {
      const sessions = this.delegation.records.sessions(run.id);
      const nativeCleanupConfirmed = sessions.length > 0 && sessions.every(session => session.cleanupConfirmed === true) && !this.delegationControls.read(run.id)?.activities.some(activity => activity.state === 'cleanup-unconfirmed');
      if (['starting', 'running', 'stopping'].includes(run.status) && run.cleanupUnconfirmed !== true && nativeCleanupConfirmed) {
        run.status = 'interrupted'; run.cleanupUnconfirmed = false; run.updatedAt = now();
        run.error = 'The application ended after native cleanup. No work has been resumed.';
        this.store.transaction(() => { this.store.putRun(run); this.store.append(run, 'run.interrupted', run.error!, { nativeCleanupConfirmed: true }); });
      } else if (activeStatuses.has(run.status) || (!run.cleanupUnconfirmed && (this.delegation.records.sessions(run.id).some(session => session.state === 'cleanup-unconfirmed') || this.delegationControls.read(run.id)?.activities.some(activity => activity.state === 'cleanup-unconfirmed')))) {
        this.store.transaction(() => {
          run.status = 'interrupted'; run.cleanupUnconfirmed = true; run.updatedAt = now();
          run.error = 'The application ended during this run. It has not been restarted; previous process cleanup could not be verified.';
          this.store.putRun(run);
          this.store.append(run, 'run.interrupted', run.error);
        });
      } else if (this.delegation.records.tasks(run.id).some(task => task.attempts.some(attempt => attempt.runtimeRecoveryRequired)) && run.status !== 'interrupted') {
        this.store.transaction(() => {
          run.status = 'interrupted'; run.updatedAt = now();
          run.error = 'Native cleanup completed, but delegated task processing was unfinished when the application ended. Explicit recovery is required; no task has been restarted.';
          this.store.putRun(run); this.store.append(run, 'run.interrupted', run.error, { nativeCleanupConfirmed: true, taskRecoveryRequired: true });
        });
      }
      this.store.exportRun(run);
    }
    this.integrations = new Integrations(this.store, id => this.accepting && !this.admission.has(id) && !this.reviews.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed)), () => this.changed(), this.workspaceOwnership);
    this.pushes = new Pushes(this.store, id => this.accepting && !this.admission.has(id) && !this.reviews.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed)), () => this.changed(), options.push, undefined, this.workspaceOwnership);
    this.reviews = new Reviews(this.store, (run, review, check) => this.nativeAdmission.adapter(run.harness ?? 'codex', this.adapterForRun(run), { owner: { kind: 'review', id: review.id }, runId: run.id, reviewId: review.id, checkId: check?.id, assertCurrent: check?.assertCurrent }), id => !this.admission.has(id) && !this.pushes.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed)), () => this.changed(), true, this.workspaceOwnership);
  }
  private preparation(): () => void { return this.workspaces.preparation(); }
  private ownWorkspace(workspace: string, provenance: WorkspaceProvenance, held: Map<string, WorkspaceLease>, access: 'read' | 'write' = 'write'): WorkspaceLease {
    return this.workspaces.own(workspace, provenance, held, access);
  }
  private planWorkspace(root: string, provenance: WorkspaceProvenance, plan: () => string, held: Map<string, WorkspaceLease>, readOnlyPlanning = false): { parent: WorkspaceLease; lease: WorkspaceLease; workspace: string } {
    return this.workspaces.plan(root, provenance, plan, held, readOnlyPlanning);
  }
  private releaseWorkspaces(held: Map<string, WorkspaceLease>, failure?: unknown): void { this.workspaces.release(held, failure); }
  private observeExecution(run: Run, work: Promise<void>): Promise<void> { return this.workspaces.observe(run, work); }
  private transferWorkspace(plan: { parent: WorkspaceLease; lease: WorkspaceLease }, held: Map<string, WorkspaceLease>): WorkspaceLease {
    return this.workspaces.transfer(plan, held);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  runExecutionSnapshot(runId: string) { return runExecutionSnapshot(this.store, this.nativeAdmission, runId); }
  delegationSnapshot(runId: string): Promise<DelegationSnapshot> { return this.delegation.snapshot(runId); }
  reviseDelegation(input: ReviseDelegationInput): Promise<DelegationSnapshot> { return this.delegation.revise(input); }
  rejectDelegation(input: DelegationRevisionInput): Promise<DelegationSnapshot> { return this.delegation.reject(input); }
  approveDelegation(input: DelegationRevisionInput): Promise<DelegationSnapshot> { return this.delegation.approve(input); }
  saveDelegationPreset(input: SaveDelegationPresetInput): Promise<DelegationSnapshot> { return this.delegation.savePreset(input); }
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
    const held = new Map<string, WorkspaceLease>();
    let failure: unknown;
    try {
      const lease = this.ownWorkspace(destination, { kind: 'checkpoint-export', id: randomUUID() }, held);
      this.workspaceOwnership.assert(lease);
      const result = this.checkpoints.restore(input, destination);
      this.workspaceOwnership.bind(lease);
      return result;
    } catch (error) { failure = error; throw error; }
    finally { this.releaseWorkspaces(held, failure); }
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
  private validateExecutionMode(mode: NonNullable<Run['executionMode']>, info: HarnessInfo): void {
    if (mode === 'code' && !info.executionModes?.includes('code')) throw new Error('Code mode is not verified for this installed harness.');
    if (info.executionModes && !info.executionModes.includes(mode)) throw new Error(info.reason ?? 'Execution is not verified for this installed harness.');
  }
  private adapterFor(harness: HarnessId): HarnessAdapter {
    const adapter = this.adapters[harness];
    if (!adapter) throw new Error(`No installed ${harness} harness route is available.`);
    return adapter;
  }
  private adapterForRun(run: Run): HarnessAdapter { return this.adapterFor(run.harness ?? 'codex'); }
  private selectionFor(conversation: Conversation): HarnessSelection | undefined {
    if (!conversation.harness && !conversation.model && !conversation.effort) return undefined;
    return { harness: conversation.harness ?? 'codex', model: conversation.model, effort: conversation.effort };
  }
  async harnessInstallations(harnessId: HarnessId = 'codex'): Promise<HarnessInstallation[]> {
    const adapter = this.adapterFor(harnessId);
    return (adapter.installations ? await adapter.installations() : []).map(item => ({ ...item, harness: harnessId }));
  }
  private async inspectExecutable(harness: HarnessId, executable?: string | null): Promise<HarnessInfo> {
    if (executable && !(await this.harnessInstallations(harness)).some(item => item.executable === executable)) throw new Error('The selected CLI is no longer discovered for this harness. Choose an installed CLI in Project settings.');
    const info = await this.nativeAdmission.adapter(harness, this.adapterFor(harness), { owner: { kind: 'app-discovery', id: randomUUID() } }).discover(executable ?? undefined);
    if (info.harness && info.harness !== harness) throw new Error('Harness discovery returned a mismatched route.');
    return { ...info, harness };
  }
  async harness(projectId?: string, executable?: string, harnessId?: HarnessId): Promise<HarnessInfo> {
    if (executable) return this.inspectExecutable(harnessId ?? 'codex', executable);
    if (!projectId) return this.inspectExecutable(harnessId ?? 'codex');
    const settings = readHarnessSettings(this.project(projectId).root);
    if (settings.error) return { available: false, authenticated: false, models: [], reason: settings.error };
    const selectedHarness = harnessId ?? settings.defaults?.harness ?? 'codex';
    const selectedExecutable = settings.defaults?.harness === selectedHarness ? settings.defaults.executable : undefined;
    try { return await this.inspectExecutable(selectedHarness, selectedExecutable); }
    catch (cause) { return { available: false, authenticated: false, models: [], reason: cause instanceof Error ? cause.message : 'CLI discovery failed.' }; }
  }
  async setExecutionMode(input: ConversationModeInput): Promise<Conversation> {
    if (!this.accepting) throw new Error('Application is closing.');
    if (input.executionMode !== 'read-only' && input.executionMode !== 'code') throw new Error('Invalid execution mode.');
    if (this.conversation(input.conversationId).kind === 'project-setup' && input.executionMode !== 'read-only') throw new Error('Project setup is read-only.');
    if (input.executionMode === 'code') {
      const conversation = this.conversation(input.conversationId);
      const project = this.project(conversation.projectId);
      const settings = readHarnessSettings(project.root);
      if (settings.error) throw new Error(settings.error);
      const selection = this.selectionFor(conversation) ?? settings.defaults;
      const harness = selection?.harness ?? 'codex';
      const info = await this.inspectExecutable(harness, settings.defaults?.harness === harness ? settings.defaults.executable : undefined);
      if (!this.accepting) throw new Error('Application is closing.');
      assertHarnessRoute(settings, harness, info.executable);
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
  private setupCleanupReason(runId: string): string | null {
    const nativeReason = this.delegation.records.setupSessionCleanupReason(runId, this.executionOrigin);
    if (nativeReason) return nativeReason;
    for (const lease of this.workspaceOwnership.snapshot().filter(value => ['run', 'main-run'].includes(value.provenance?.kind ?? '') && value.provenance?.id === runId)) {
      const reason = cleanupReconciliationReason(lease.provenance?.origin, this.executionOrigin);
      if (reason) return reason;
    }
    return null;
  }
  projectSetup(projectId: string): ProjectSetupSnapshot {
    const project = this.project(projectId);
    const context = readProjectContext(project.root);
    const conversations = new Set(this.store.conversations().filter(conversation => conversation.projectId === projectId && conversation.kind === 'project-setup').map(conversation => conversation.id));
    const runs = this.store.runs().filter(run => conversations.has(run.conversationId));
    const busy = this.setupAdmission.has(projectId) || runs.some(run => activeStatuses.has(run.status) || run.cleanupUnconfirmed);
    const uncertain = runs.filter(run => run.cleanupUnconfirmed || run.status === 'stop-unconfirmed');
    const cleanupReason = uncertain.map(run => this.setupCleanupReason(run.id)).find(reason => reason !== null);
    const cleanup = uncertain.length ? { canReconcile: !this.setupAdmission.has(projectId) && !runs.some(run => this.active.has(run.id)) && !cleanupReason, reason: cleanupReason ?? 'A later boot on the original Mac confirms that the previous inspection processes have exited. Verify cleanup before starting another inspection.' } : undefined;
    return { context, cleanup, inspections: runs.map(run => {
      let proposal; let error;
      if (run.status === 'completed') {
        try { proposal = parseSetupProposal(this.store.messages(run.conversationId).filter(message => message.runId === run.id && message.role === 'assistant').map(message => message.text).join('')); }
        catch (cause) { error = cause instanceof Error ? cause.message : 'Invalid setup proposal.'; }
        try {
          if (!run.workspaceIdentity) throw new Error('This inspection lacks project directory identity. Inspect again before approving.');
          assertWorkspaceIdentity(project.root, run.workspaceIdentity);
        } catch (cause) { error = cause instanceof Error ? cause.message : 'Project directory changed. Inspect again before approving.'; }
      } else if (run.status === 'failed') error = run.error;
      const events = this.store.events(run.id);
      const approved = events.findLast(event => event.type === 'project-context.approved');
      const pendingApproval = !approved && events.some(event => event.type === 'project-context.approval-requested');
      if (pendingApproval) error = 'The approval write has no confirmed receipt. Review the current approved context above, then inspect again before approving further changes.';
      return { conversationId: run.conversationId, run, proposal, error, canApprove: !busy && !error && !approved && !pendingApproval && run.id === runs.at(-1)?.id && Boolean(proposal) && !context.error && run.projectContext?.revision === context.revision, ...(typeof approved?.data.revision === 'string' ? { approvedRevision: approved.data.revision } : {}) };
    }) };
  }
  reconcileProjectSetupCleanup(projectId: string): ProjectSetupSnapshot {
    if (!this.accepting) throw new Error('Application is closing.');
    const snapshot = this.projectSetup(projectId);
    if (this.setupAdmission.has(projectId) || snapshot.inspections.some(item => this.active.has(item.run.id) || this.admission.has(item.conversationId))) throw new Error('Wait for active inspection work to finish before verifying cleanup.');
    if (!snapshot.cleanup) return snapshot;
    if (!snapshot.cleanup.canReconcile) throw new Error(snapshot.cleanup.reason);
    this.setupAdmission.add(projectId);
    try {
      this.store.transaction(() => {
        for (const { run } of snapshot.inspections) {
          if (!run.cleanupUnconfirmed && run.status !== 'stop-unconfirmed') continue;
          const reason = this.setupCleanupReason(run.id);
          if (reason) throw new Error(reason);
          const workspaces = this.workspaceOwnership.snapshot().filter(lease => ['run', 'main-run'].includes(lease.provenance?.kind ?? '') && lease.provenance?.id === run.id);
          for (const lease of workspaces) {
            const workspaceReason = cleanupReconciliationReason(lease.provenance?.origin, this.executionOrigin);
            if (workspaceReason) throw new Error(workspaceReason);
          }
          this.delegation.records.reconcileProjectSetupSessions(run.id, this.executionOrigin);
          for (const lease of workspaces) this.workspaceOwnership.release({ ...lease, cleanupConfirmed: true, cleanupEvidence: { reconciliation: 'later-boot-original-setup-owner', recordedOrigin: lease.provenance!.origin!, observedOrigin: this.executionOrigin! } });
          run.status = 'interrupted'; run.cleanupUnconfirmed = false; run.updatedAt = now();
          run.error = 'Previous inspection execution ended with an earlier boot on this Mac. No work has been restarted.';
          this.store.putRun(run);
          this.store.append(run, 'run.cleanup-reconciled', run.error, { recordedOrigin: run.executionOrigin, observedOrigin: this.executionOrigin });
        }
      });
      for (const { run } of snapshot.inspections) if (run.status === 'interrupted' && !run.cleanupUnconfirmed) this.nativeAdmission.reconcileSetupCleanup(run.id);
    } finally { this.setupAdmission.delete(projectId); this.changed(); }
    return this.projectSetup(projectId);
  }
  async inspectProject(input: InspectProjectInput): Promise<Run> {
    if (!this.accepting) throw new Error('Application is closing.');
    const project = this.project(input.projectId);
    if (this.setupAdmission.has(project.id) || this.projectSetup(project.id).inspections.some(item => activeStatuses.has(item.run.status) || item.run.cleanupUnconfirmed)) throw new Error('Project inspection is already active or awaiting cleanup.');
    this.setupAdmission.add(project.id);
    try {
      const context = readProjectContext(project.root);
      if (context.error) throw new Error(context.error);
      const prompt = setupPrompt(context, input.brief);
      let conversation = this.store.conversations().findLast(item => item.projectId === project.id && item.kind === 'project-setup');
      if (!conversation) {
        conversation = { ...this.createConversation(project.id), kind: 'project-setup', title: 'Project setup' };
        this.store.putConversation(conversation);
      }
      return await this.#send({ conversationId: conversation.id, text: prompt, ...input.selection }, { executable: input.executable, expectedContextRevision: context.revision });
    } finally { this.setupAdmission.delete(project.id); this.changed(); }
  }
  approveProjectSetup(input: ApproveProjectSetupInput): ProjectContextSnapshot {
    if (!this.accepting) throw new Error('Application is closing.');
    const snapshot = this.projectSetup(input.projectId);
    const inspection = snapshot.inspections.find(item => item.run.id === input.runId);
    if (!inspection?.canApprove || inspection.proposal?.revision !== input.proposalRevision || inspection.run.projectContext?.revision !== input.expectedContextRevision) throw new Error('This proposal or approved context changed. Reload project setup before approving.');
    const value = parseProjectContext(input.value);
    const held = new Map<string, WorkspaceLease>();
    let failure: unknown;
    const lease = this.ownWorkspace(this.project(input.projectId).root, { kind: 'setup-approval', id: randomUUID(), projectId: input.projectId, conversationId: inspection.run.conversationId }, held);
    try {
      this.workspaceOwnership.assert(lease);
      this.store.append(inspection.run, 'project-context.approval-requested', 'Project context approval requested', { proposalRevision: input.proposalRevision, expectedContextRevision: input.expectedContextRevision, value });
      assertWorkspaceIdentity(this.project(input.projectId).root, inspection.run.workspaceIdentity!);
      const saved = writeProjectContext(this.project(input.projectId).root, value, input.expectedContextRevision);
      this.store.append(inspection.run, 'project-context.approved', 'Project context approved', { proposalRevision: input.proposalRevision, revision: saved.revision, value: saved.value });
      this.store.exportRun(inspection.run);
      return saved;
    } catch (error) { failure = error; throw error; }
    finally { this.releaseWorkspaces(held, failure); this.changed(); }
  }
  private project(id: string): Project {
    const project = this.store.projects().find(value => value.id === id);
    if (!project) throw new Error('Project does not exist.');
    return project;
  }
  private validateSelection(selection: HarnessSelection, info: HarnessInfo): void {
    if (!info.available || !info.authenticated) throw new Error(info.reason ?? `Sign into the installed ${selection.harness} CLI first.`);
    const model = info.models.find(candidate => candidate.id === selection.model);
    if (info.harness !== selection.harness || !model || !model.efforts.includes(selection.effort)) throw new Error('Choose an available model and effort.');
  }
  async saveProjectDefaults(input: SaveProjectDefaultsInput): Promise<ProjectHarnessSettings> {
    if (!this.accepting) throw new Error('Application is closing.');
    const project = this.project(input.projectId);
    const info = await this.inspectExecutable(input.defaults.harness, input.defaults.executable);
    if (!this.accepting) throw new Error('Application is closing.');
    this.validateSelection(input.defaults, info);
    const held = new Map<string, WorkspaceLease>();
    let failure: unknown;
    try {
      const lease = this.ownWorkspace(project.root, { kind: 'harness-settings', id: randomUUID(), projectId: project.id }, held);
      this.workspaceOwnership.assert(lease);
      const settings = writeHarnessSettings(project.root, input.defaults, input.expectedRevision, input.enabledRoutes);
      this.changed();
      return settings;
    } catch (error) { failure = error; throw error; }
    finally { this.releaseWorkspaces(held, failure); }
  }
  async setConversationSelection(input: ConversationSelectionInput): Promise<Conversation> {
    if (!this.accepting) throw new Error('Application is closing.');
    this.conversation(input.conversationId);
    if (input.selection) {
      const conversation = this.conversation(input.conversationId);
      const project = this.project(conversation.projectId);
      const settings = readHarnessSettings(project.root);
      if (settings.error) throw new Error(settings.error);
      const info = await this.inspectExecutable(input.selection.harness, settings.defaults?.harness === input.selection.harness ? settings.defaults.executable : undefined);
      if (!this.accepting) throw new Error('Application is closing.');
      assertHarnessRoute(settings, input.selection.harness, info.executable);
      this.validateSelection(input.selection, info);
    }
    const conversation = { ...this.conversation(input.conversationId), harness: input.selection?.harness, model: input.selection?.model ?? '', effort: input.selection?.effort ?? '', updatedAt: now() };
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
  private recoveryHost(): RecoveryHost {
    return {
      isAccepting: () => this.accepting,
      store: this.store,
      checkpoints: this.checkpoints,
      memory: this.memory,
      reviews: this.reviews,
      pushes: this.pushes,
      integrations: this.integrations,
      executionOrigin: this.executionOrigin,
      admission: this.admission,
      active: this.active,
      conversation: id => this.conversation(id),
      project: id => this.project(id),
      inspectExecutable: (harness, executable) => this.inspectExecutable(harness, executable),
      validateSelection: (selection, info) => this.validateSelection(selection, info),
      validateExecutionMode: (mode, info) => this.validateExecutionMode(mode, info),
      preparation: () => this.preparation(),
      planWorkspace: (root, provenance, plan, held, readOnlyPlanning) => this.planWorkspace(root, provenance, plan, held, readOnlyPlanning),
      transferWorkspace: (plan, held) => this.transferWorkspace(plan, held),
      releaseWorkspaces: (held, failure) => this.releaseWorkspaces(held, failure),
      observeExecution: (run, work) => this.observeExecution(run, work),
      execute: (run, controller, lease) => this.execute(run, controller, lease),
      finish: (run, status, error) => this.finish(run, status, error),
      changed: () => this.changed(),
    };
  }
  private async recoverFromCheckpoint(kind: 'restart' | 'rerun', input: RestartCheckpointInput | RerunCheckpointInput): Promise<LinkedRunResult> {
    return recoverLinkedCheckpoint(this.recoveryHost(), kind, input);
  }
  async send(input: SendInput): Promise<Run> { return this.#send(input); }
  async #send(input: SendInput, setup?: { executable?: string; expectedContextRevision: string | null }): Promise<Run> {
    if (!this.accepting) throw new Error('Application is closing.');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64_000) throw new Error('Enter a message of at most 64,000 characters.');
    let conversation = this.conversation(input.conversationId);
    if (conversation.kind === 'project-setup' && !setup) throw new Error('Use the dedicated project inspection action for setup conversations.');
    if (this.admission.has(conversation.id) || this.reviews.hasActiveWork(conversation.id) || this.pushes.hasActiveWork(conversation.id) || this.store.runs().some(run => run.conversationId === conversation.id && (activeStatuses.has(run.status) || run.cleanupUnconfirmed))) throw new Error('This conversation already has active work.');
    if (this.integrations.blocksNewWork(conversation.id)) throw new Error('Finish interrupted parent integration before starting new work.');
    this.admission.add(conversation.id);
    const prepared = this.preparation();
    const held = new Map<string, WorkspaceLease>();
    let preparationFailure: unknown;
    let createdRun: Run | undefined;
    try {
      const project = this.project(conversation.projectId);
      const rootIdentity = workspaceIdentity(project.root);
      const settings = readHarnessSettings(project.root);
      if (settings.error) throw new Error(settings.error);
      const savedSelection = this.selectionFor(conversation);
      const explicit = input.harness !== undefined || input.model !== undefined || input.effort !== undefined;
      const defaultHarness = settings.defaults?.harness ?? 'codex';
      const selectedHarness = input.harness ?? savedSelection?.harness ?? settings.defaults?.harness ?? 'codex';
      const sameHarnessSelection = savedSelection?.harness === selectedHarness ? savedSelection : settings.defaults?.harness === selectedHarness ? settings.defaults : undefined;
      const selection: HarnessSelection = explicit
        ? { harness: selectedHarness, model: input.model ?? sameHarnessSelection?.model ?? '', effort: input.effort ?? sameHarnessSelection?.effort ?? '' }
        : savedSelection ?? settings.defaults ?? { harness: defaultHarness, model: '', effort: '' };
      const info = await this.inspectExecutable(selection.harness, setup?.executable ?? (settings.defaults?.harness === selection.harness ? settings.defaults.executable : undefined));
      if (!this.accepting) throw new Error('Application is closing.');
      conversation = this.conversation(input.conversationId);
      assertWorkspaceIdentity(project.root, rootIdentity);
      const freshSettings = readHarnessSettings(project.root);
      if (freshSettings.error) throw new Error(freshSettings.error);
      if (freshSettings.revision !== settings.revision) throw new Error('Project harness settings changed during discovery. Try again.');
      if (!selection.model && !selection.effort && !savedSelection && !settings.defaults) {
        selection.model = info.models[0]?.id ?? '';
        selection.effort = info.models[0]?.defaultEffort ?? '';
      }
      assertHarnessRoute(settings, selection.harness, info.executable);
      this.validateSelection(selection, info);
      const projectContext = readProjectContext(project.root);
      if (projectContext.error) throw new Error(projectContext.error);
      if (setup && projectContext.revision !== setup.expectedContextRevision) throw new Error('Project context changed during setup discovery. Inspect again with the current context.');
      const memory = this.memory.prepare(project.id, input.text);
      const settingsSource = explicit || savedSelection ? 'conversation' : settings.defaults ? 'project' : 'native';
      const executionMode = conversation.executionMode ?? 'read-only';
      if (conversation.kind === 'project-setup' && executionMode !== 'read-only') throw new Error('Project setup is read-only.');
      this.validateExecutionMode(executionMode, info);
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
      const runId = randomUUID();
      const plan = () => conversation.kind === 'project-setup' ? project.root : plannedConversationWorkspace(project.root, conversation.id, previous);
      const planned = this.planWorkspace(project.root, { kind: 'run', id: runId, projectId: project.id, conversationId: conversation.id }, plan, held, executionMode === 'read-only');
      const workspace = planned.lease.access === 'read' || conversation.kind === 'project-setup' ? project.root : prepareWorkspace(project.root, conversation.id, previous);
      if (workspace !== planned.workspace) throw new Error('Conversation workspace changed during preparation.');
      planned.lease = this.workspaceOwnership.bind(planned.lease);
      held.set(planned.lease.reservationId, planned.lease);
      if (executionMode === 'code') inspectGitWorkspace(project.root, workspace);
      this.reviews.invalidate(conversation.id);
      assertWorkspaceIdentity(project.root, rootIdentity);
      const run: Run = { harnessAuthorizationRevision: settings.revision, enabledHarnessRoutes: settings.enabledRoutes?.map(route => ({ ...route })) ?? (info.executable ? [{ harness: selection.harness, executable: info.executable }] : []), executionOrigin: this.executionOrigin, workspaceIdentity: workspaceIdentity(workspace), projectContext, harness: selection.harness, executable: info.executable, executableVersion: info.version, id: runId, projectId: project.id, conversationId: conversation.id, ...(recoveryMessages ? { recoveryMessages } : {}), status: 'starting', model: selection.model, effort: selection.effort, executionMode, settingsSource, memory, projectSettingsRevision: settings.revision, workspace, createdAt: now(), updatedAt: now(), lastActivityAt: now() };
      run.logsPath = join(this.store.runDirectory(run), 'logs');
      this.store.transaction(() => {
        this.store.putConversation({ ...conversation, title: conversation.title === 'New conversation' ? input.text.trim().slice(0, 64) : conversation.title, ...(explicit ? { harness: selection.harness, model: selection.model, effort: selection.effort } : {}), updatedAt: now() });
        this.store.putRun(run);
        this.store.putMessage({ id: randomUUID(), runId: run.id, conversationId: conversation.id, role: 'user', text: input.text, createdAt: now() });
        this.store.append(run, 'run.created', executionMode === 'code' ? 'Code conversation queued' : 'Read-only conversation queued', { harness: run.harness, model: run.model, effort: run.effort, settingsSource, projectSettingsRevision: settings.revision, nativeVersion: info.version ?? 'unknown', executable: run.executable, workspace, executionMode });
      });
      createdRun = run;
      try { this.memory.retain(project.id, run.id, memory); this.store.exportRun(run); }
      catch { this.finish(run, 'failed', 'Could not export run logs. No harness was launched.'); throw new Error('Could not export run logs.'); }
      if (workspace !== project.root) {
        try { this.checkpoints.capture(run, 'before-turn'); }
        catch (cause) { preparationFailure = cause; this.checkpoints.failed(run, cause); run.cleanupUnconfirmed = !workspaceCleanupConfirmed(cause); this.finish(run, 'failed', 'Could not retain the starting checkpoint. No harness was launched.'); throw cause; }
      } else {
        this.checkpoints.failed(run, new Error('File recovery is currently supported only for Git worktrees with a committed HEAD. This read-only folder run has retained history but no recoverable code checkpoint.'));
      }
      const controller = new AbortController();
      // Register ownership before asynchronous adapter startup; Stop can interrupt launch too.
      const state = { controller, done: Promise.resolve(), run };
      const lease = this.transferWorkspace(planned, held);
      this.active.set(run.id, state);
      state.done = this.observeExecution(run, this.execute(run, controller, lease));
      this.changed();
      return { ...run };
    } catch (error) {
      if (workspaceCleanupConfirmed(preparationFailure)) preparationFailure = error;
      if (createdRun && !this.active.has(createdRun.id)) {
        createdRun.cleanupUnconfirmed ||= !workspaceCleanupConfirmed(preparationFailure);
        if (createdRun.status === 'starting') this.finish(createdRun, 'failed', 'Workspace preparation failed before native dispatch.');
        else this.store.putRun(createdRun);
      }
      throw error;
    } finally {
      try { this.releaseWorkspaces(held, preparationFailure); } finally { this.admission.delete(conversation.id); prepared(); }
    }
  }
  private async execute(run: Run, controller: AbortController, lease: WorkspaceLease): Promise<void> {
    let sessionId: string | undefined;
    let bound = false;
    let sessionSettled = false;
    let sessionCleanupConfirmed = false;
    let adapterInvoked = false;
    let runtimeCleanupConfirmed = true;
    let nativeCleanupConfirmed = false;
    const settleSession = (status: 'completed' | 'failed' | 'interrupted', cleanupConfirmed: boolean, cleanupEvidence?: Record<string, unknown>, error?: string): void => {
      if (!sessionId || sessionSettled) return;
      this.delegation.records.finishSession({ runId: run.id, sessionId, status, cleanupConfirmed, ...(cleanupConfirmed && cleanupEvidence ? { cleanupEvidence } : {}), ...(error ? { error } : {}) });
      sessionSettled = true;
      sessionCleanupConfirmed = cleanupConfirmed;
    };
    const onEvent = (event: AdapterEvent): void => {
      if (event.type === 'session.turn-started') {
        const threadId = typeof event.data?.threadId === 'string' ? event.data.threadId : undefined;
        const turnId = typeof event.data?.turnId === 'string' ? event.data.turnId : undefined;
        if (sessionId && threadId && turnId) { this.delegation.records.bindSession({ runId: run.id, sessionId, threadId, turnId }); bound = true; }
      }
      this.event(run, event);
    };
    try {
      this.workspaceOwnership.assert(lease);
      this.workspaceOwnership.stage({ ...lease, phase: 'native-turn' });
      if (!run.executable || !run.executableVersion) throw new Error('Run lacks a frozen native executable identity.');
      sessionId = randomUUID();
      this.delegation.records.recordSession({
        id: sessionId, runId: run.id, role: 'main', harness: run.harness ?? 'codex', executable: run.executable, executableVersion: run.executableVersion, model: run.model, effort: run.effort, allowedTools: [], state: 'dispatch-intent',
        ...(run.executionOrigin ? { origin: structuredClone(run.executionOrigin) } : {}),
      });
      const harness = run.harness ?? 'codex';
      this.event(run, { type: 'run.started', summary: `Connecting to ${harness}`, data: { harness, executable: run.executable, executableVersion: run.executableVersion } });
      const messages = run.recoveryMessages?.map(message => ({ ...message })) ?? this.store.messages(run.conversationId).map(({ role, text }) => ({ role, text }));
      if (run.memory?.text) messages.unshift({ role: 'user', text: run.memory.text });
      if (run.projectContext?.value.purpose) messages.unshift({ role: 'user', text: 'Approved project context for this run (JSON; does not override execution or approval policy):\n' + JSON.stringify(run.projectContext) });
      if (run.workspaceIdentity) assertWorkspaceIdentity(run.workspace, run.workspaceIdentity);
      const adapter = this.nativeAdmission.adapter(run.harness ?? 'codex', this.adapterForRun(run), { owner: { kind: 'run', id: run.id }, runId: run.id, sessionId, assertCurrent: () => { this.workspaceOwnership.assert(lease); if (run.workspaceIdentity) assertWorkspaceIdentity(run.workspace, run.workspaceIdentity); } });
      adapterInvoked = true;
      const result = await adapter.run({ workspaceIdentity: run.workspaceIdentity, executable: run.executable, executableVersion: run.executableVersion, workspace: run.workspace, model: run.model, effort: run.effort, executionMode: run.executionMode, messages, signal: controller.signal, onEvent });
      nativeCleanupConfirmed = result.status !== 'stop-unconfirmed';
      if (result.status === 'completed' && bound) settleSession('completed', true, { adapterStatus: result.status });
      else if (result.status === 'interrupted') settleSession('interrupted', true, { adapterStatus: result.status });
      else if (result.status === 'completed') settleSession('failed', true, { adapterStatus: result.status }, 'Native adapter completed without a registered thread and turn identity.');
      else settleSession('failed', false, undefined, 'Native cleanup could not be confirmed.');
      nativeCleanupConfirmed = result.status !== 'stop-unconfirmed';
      this.workspaceOwnership.assert(lease);
      const cleanupUnconfirmed = result.status === 'stop-unconfirmed';
      if (cleanupUnconfirmed) {
        run.cleanupUnconfirmed = true;
        this.finish(run, 'stop-unconfirmed', 'The harness stopped responding; cleanup could not be confirmed.');
      } else if (result.status === 'completed' && !bound) this.finish(run, 'failed', 'Native adapter completed without a registered thread and turn identity.');
      else this.finish(run, result.status);
      if (result.status === 'completed' && bound && run.checkpoints?.length) {
        try { this.workspaceOwnership.stage({ ...lease, phase: 'completed-checkpoint' }); this.workspaceOwnership.assert(lease); this.checkpoints.capture(run, 'completed-turn'); }
        catch (cause) { runtimeCleanupConfirmed &&= workspaceCleanupConfirmed(cause); this.checkpoints.failed(run, cause); if (!workspaceCleanupConfirmed(cause)) { run.cleanupUnconfirmed = true; this.finish(run, 'stop-unconfirmed', 'Checkpoint process cleanup could not be confirmed.'); } }
      }
    } catch (error) {
      runtimeCleanupConfirmed &&= workspaceCleanupConfirmed(error);
      const message = error instanceof Error ? error.message : 'Harness failed.';
      const trustedFailure = error instanceof AdapterRunFailure;
      const confirmedBeforeDispatch = !adapterInvoked;
      const confirmedSessionCleanup = nativeCleanupConfirmed || sessionSettled && sessionCleanupConfirmed;
      try {
        if (trustedFailure) settleSession('failed', true, error.cleanupEvidence, message);
        else if (nativeCleanupConfirmed) settleSession('failed', true, { adapterResultCleanupConfirmed: true }, message);
        else if (confirmedBeforeDispatch) settleSession('failed', true, { dispatch: 'not-invoked' }, message);
        else settleSession('failed', false, undefined, message);
      } catch { /* The run failure below remains authoritative. */ }
      nativeCleanupConfirmed = trustedFailure || confirmedBeforeDispatch || confirmedSessionCleanup;
      if (nativeCleanupConfirmed && runtimeCleanupConfirmed) this.finish(run, 'failed', message);
      else {
        run.cleanupUnconfirmed = true;
        this.finish(run, 'stop-unconfirmed', `${message} Process cleanup could not be confirmed.`);
      }
    } finally {
      try {
        const cleanupConfirmed = nativeCleanupConfirmed && runtimeCleanupConfirmed;
        this.workspaceOwnership.release({ ...lease, cleanupConfirmed, cleanupEvidence: { runId: run.id, nativeCleanupConfirmed, runtimeCleanupConfirmed, durableStatus: this.store.runs().find(value => value.id === run.id)?.status ?? 'unknown' } });
      } finally { this.active.delete(run.id); this.changed(); }
    }
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
    this.store.transaction(() => { this.store.putRun(run); this.store.append(run, 'run.stopping', `Stopping ${run.harness ?? 'codex'}; awaiting confirmation`); });
    this.changed(); state.controller.abort(); await state.done;
  }
  hasActiveWork(options: { includeDiscovery?: boolean } = {}): boolean { return this.nativeAdmission.hasActiveWork(options.includeDiscovery !== false) || this.active.size > 0 || this.admission.size > 0 || this.reviews.hasActiveWork() || this.pushes.hasActiveWork(); }
  async stopAll(): Promise<void> {
    await this.nativeAdmission.stopAll();
    await this.pushes.stopAll();
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    await Promise.all(this.store.reviews().filter(review => review.status === 'checking').map(review => this.reviews.stop(review.id)));
  }
  async close(): Promise<void> {
    this.accepting = false;
    await this.nativeAdmission.close();
    await this.workspaces.wait();
    await this.pushes.close();
    await this.reviews.close();
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    this.store.close();
  }
}
