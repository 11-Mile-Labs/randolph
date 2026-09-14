import { assertWorkspaceIdentity } from './workspace-identity.js';
import { readExecutionOrigin, type ExecutionOrigin } from './execution-origin.js';
import { AppSettings, type AppSettingsSnapshot, type SaveAppSettingsInput, type SaveGlobalMemoryInput } from './app-settings.js';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { Store } from './store.js';
import { reconstructLegacyWorkspaceOwnership } from './workspace-recovery.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceLease } from './workspace-leases.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { RunWorkspace } from './run-workspace.js';
import { recoverLinkedCheckpoint, type RecoveryHost } from './checkpoint-recovery.js';
import { NativeAdmission } from './native-admission.js';
import { canonicalProject } from './workspace.js';
import { readHarnessSettings } from './harness-settings.js';
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
import type { ApproveProjectSetupInput, InspectProjectInput, ProjectSetupSnapshot, AdapterEvent, ApproveReviewInput, ChatEventsInput, ChatEventsResult, Conversation, ConversationModeInput, ConversationSelectionInput, HarnessAdapter, HarnessId, HarnessInfo, HarnessInstallation, LinkedRunResult, Project, ProjectHarnessSettings, RerunCheckpointInput, RestartCheckpointInput, ReviewRecord, Run, SaveProjectDefaultsInput, SendInput, WorkspaceSnapshot } from './contracts.js';
import type { ProjectContextSnapshot } from './project-context.js';
import { RuntimeHarness } from './runtime-harness.js';
import { reconcileInterruptedRuns } from './runtime-reopen.js';
import { approveProjectSetup, inspectProject, projectSetupSnapshot, reconcileProjectSetupCleanup, type ProjectSetupHost } from './project-setup-runtime.js';
import { dispatchOrdinaryRun, type DispatchHost } from './run-dispatch.js';
import { ACTIVE_RUN_STATUSES, now } from './runtime-status.js';
export type * from './contracts.js';
export { Store } from './store.js';

export class Runtime {
  readonly store: Store;
  private readonly nativeAdmission: NativeAdmission;
  private readonly workspaceOwnership: WorkspaceOwnership;
  private readonly workspaces: RunWorkspace;
  readonly adapter?: HarnessAdapter;
  private readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  private readonly routes: RuntimeHarness;
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
    this.routes = new RuntimeHarness(
      this.adapters,
      this.nativeAdmission,
      this.store,
      this.workspaces,
      this.workspaceOwnership,
      id => this.admission.has(id) || this.reviews.hasActiveWork(id) || this.store.runs().some(run => run.conversationId === id && (ACTIVE_RUN_STATUSES.has(run.status) || run.cleanupUnconfirmed)),
      () => this.accepting,
      () => this.changed(),
      id => this.project(id),
      id => this.conversation(id),
    );
    this.delegation = new DelegationCommands(this.store, {
      assertMutable: run => {
        if (!this.accepting || this.admission.has(run.conversationId) || this.active.has(run.id) || this.reviews?.hasActiveWork(run.conversationId) || this.pushes?.hasActiveWork(run.conversationId)) throw new Error('Wait for current work to settle before changing this proposal.');
        const runs = this.store.runs().filter(candidate => candidate.conversationId === run.conversationId);
        if (runs.at(-1)?.id !== run.id) throw new Error('A newer conversation request superseded this proposal.');
        if (runs.some(candidate => ACTIVE_RUN_STATUSES.has(candidate.status) || candidate.cleanupUnconfirmed) || this.delegation.records.sessions(run.id).some(session => ['prepared', 'dispatch-intent', 'running', 'cleanup-unconfirmed'].includes(session.state))) throw new Error('Native work and cleanup must settle before a proposal decision.');
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
    reconcileInterruptedRuns(this.store, this.delegation, this.delegationControls);
    this.integrations = new Integrations(this.store, id => this.accepting && !this.admission.has(id) && !this.reviews.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (ACTIVE_RUN_STATUSES.has(run.status) || run.cleanupUnconfirmed)), () => this.changed(), this.workspaceOwnership);
    this.pushes = new Pushes(this.store, id => this.accepting && !this.admission.has(id) && !this.reviews.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (ACTIVE_RUN_STATUSES.has(run.status) || run.cleanupUnconfirmed)), () => this.changed(), options.push, undefined, this.workspaceOwnership);
    this.reviews = new Reviews(this.store, (run, review, check) => this.nativeAdmission.adapter(run.harness ?? 'codex', this.routes.adapterForRun(run), { owner: { kind: 'review', id: review.id }, runId: run.id, reviewId: review.id, checkId: check?.id, assertCurrent: check?.assertCurrent }), id => !this.admission.has(id) && !this.pushes.hasActiveWork(id) && !this.store.runs().some(run => run.conversationId === id && (ACTIVE_RUN_STATUSES.has(run.status) || run.cleanupUnconfirmed)), () => this.changed(), true, this.workspaceOwnership);
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
      const lease = this.workspaces.own(destination, { kind: 'checkpoint-export', id: randomUUID() }, held);
      this.workspaceOwnership.assert(lease);
      const result = this.checkpoints.restore(input, destination);
      this.workspaceOwnership.bind(lease);
      return result;
    } catch (error) { failure = error; throw error; }
    finally { this.workspaces.release(held, failure); }
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
  restartRun(input: RestartCheckpointInput): Promise<LinkedRunResult> { return recoverLinkedCheckpoint(this.recoveryHost(), 'restart', input); }
  rerunFromCheckpoint(input: RerunCheckpointInput): Promise<LinkedRunResult> { return recoverLinkedCheckpoint(this.recoveryHost(), 'rerun', input); }
  memorySnapshot(projectId: string): MemorySnapshot { return this.memory.snapshot(projectId); }
  memoryHistory(projectId: string, reference: LessonRef): LessonVersion[] { return this.memory.history(projectId, reference); }
  memoryCommand(input: MemoryCommand): MemorySnapshot {
    if (!this.accepting) throw new Error('Application is closing.');
    return this.memory.command(input);
  }
  async harnessInstallations(harnessId: HarnessId = 'codex'): Promise<HarnessInstallation[]> { return this.routes.installations(harnessId); }
  async harness(projectId?: string, executable?: string, harnessId?: HarnessId): Promise<HarnessInfo> { return this.routes.inspect(projectId, executable, harnessId); }
  async setExecutionMode(input: ConversationModeInput): Promise<Conversation> { return this.routes.setExecutionMode(input); }
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
  private setupHost(): ProjectSetupHost {
    return {
      isAccepting: () => this.accepting,
      store: this.store,
      workspaces: this.workspaces,
      ownership: this.workspaceOwnership,
      delegation: this.delegation,
      nativeAdmission: this.nativeAdmission,
      executionOrigin: this.executionOrigin,
      admission: this.admission,
      setupAdmission: this.setupAdmission,
      active: this.active,
      project: id => this.project(id),
      createConversation: projectId => this.createConversation(projectId),
      send: (input, setup) => this.#send(input, setup),
      changed: () => this.changed(),
    };
  }
  projectSetup(projectId: string): ProjectSetupSnapshot { return projectSetupSnapshot(this.setupHost(), projectId); }
  reconcileProjectSetupCleanup(projectId: string): ProjectSetupSnapshot { return reconcileProjectSetupCleanup(this.setupHost(), projectId); }
  async inspectProject(input: InspectProjectInput): Promise<Run> { return inspectProject(this.setupHost(), input); }
  approveProjectSetup(input: ApproveProjectSetupInput): ProjectContextSnapshot { return approveProjectSetup(this.setupHost(), input); }
  private project(id: string): Project {
    const project = this.store.projects().find(value => value.id === id);
    if (!project) throw new Error('Project does not exist.');
    return project;
  }
  async saveProjectDefaults(input: SaveProjectDefaultsInput): Promise<ProjectHarnessSettings> { return this.routes.saveProjectDefaults(input); }
  async setConversationSelection(input: ConversationSelectionInput): Promise<Conversation> { return this.routes.setConversationSelection(input); }
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
  private planWorkspace(root: string, provenance: { kind: string; id: string; projectId?: string; conversationId?: string }, plan: () => string, held: Map<string, WorkspaceLease>, readOnlyPlanning = false): { parent: WorkspaceLease; lease: WorkspaceLease; workspace: string } {
    return this.workspaces.plan(root, provenance, plan, held, readOnlyPlanning);
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
      inspectExecutable: (harness, executable) => this.routes.inspectExecutable(harness, executable),
      validateSelection: (selection, info) => this.routes.validateSelection(selection, info),
      validateExecutionMode: (mode, info) => this.routes.validateExecutionMode(mode, info),
      preparation: () => this.workspaces.preparation(),
      planWorkspace: (root, provenance, plan, held, readOnlyPlanning) => this.planWorkspace(root, provenance, plan, held, readOnlyPlanning),
      transferWorkspace: (plan, held) => this.workspaces.transfer(plan, held),
      releaseWorkspaces: (held, failure) => this.workspaces.release(held, failure),
      observeExecution: (run, work) => this.workspaces.observe(run, work),
      execute: (run, controller, lease) => this.execute(run, controller, lease),
      finish: (run, status, error) => this.finish(run, status, error),
      changed: () => this.changed(),
    };
  }
  private dispatchHost(): DispatchHost {
    return {
      isAccepting: () => this.accepting,
      store: this.store,
      workspaces: this.workspaces,
      ownership: this.workspaceOwnership,
      harness: this.routes,
      memory: this.memory,
      checkpoints: this.checkpoints,
      reviews: this.reviews,
      pushes: this.pushes,
      integrations: this.integrations,
      executionOrigin: this.executionOrigin,
      admission: this.admission,
      active: this.active,
      conversation: id => this.conversation(id),
      project: id => this.project(id),
      planWorkspace: (root, provenance, plan, held, readOnlyPlanning) => this.planWorkspace(root, provenance, plan, held, readOnlyPlanning),
      execute: (run, controller, lease) => this.execute(run, controller, lease),
      finish: (run, status, error) => this.finish(run, status, error),
      changed: () => this.changed(),
    };
  }
  async send(input: SendInput): Promise<Run> { return this.#send(input); }
  async #send(input: SendInput, setup?: { executable?: string; expectedContextRevision: string | null }): Promise<Run> {
    return dispatchOrdinaryRun(this.dispatchHost(), input, setup);
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
      const adapter = this.nativeAdmission.adapter(run.harness ?? 'codex', this.routes.adapterForRun(run), { owner: { kind: 'run', id: run.id }, runId: run.id, sessionId, assertCurrent: () => { this.workspaceOwnership.assert(lease); if (run.workspaceIdentity) assertWorkspaceIdentity(run.workspace, run.workspaceIdentity); } });
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
