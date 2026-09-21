import { readExecutionOrigin, type ExecutionOrigin } from './execution-origin.js';
import {
  AppSettings,
  type AppSettingsSnapshot,
  type SaveAppSettingsInput,
  type SaveGlobalMemoryInput,
} from './app-settings.js';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { reconstructLegacyWorkspaceOwnership } from './workspace-recovery.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceLease, WorkspaceProvenance } from './workspace-leases.js';
import { RunWorkspace } from './run-workspace.js';
import { recoverLinkedCheckpoint } from './checkpoint-recovery.js';
import { NativeAdmission } from './native-admission.js';
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
import { delegationCommandPolicy } from './delegation-command-policy.js';
import type {
  DelegationSnapshot,
  DelegationRevisionInput,
  ReviseDelegationInput,
  SaveDelegationPresetInput,
} from './delegation-contracts.js';
import type {
  ApproveProjectSetupInput,
  InspectProjectInput,
  ProjectSetupSnapshot,
  AdapterEvent,
  ApproveReviewInput,
  ChatEventsInput,
  ChatEventsResult,
  Conversation,
  ConversationModeInput,
  ConversationSelectionInput,
  HarnessAdapter,
  HarnessId,
  HarnessInfo,
  HarnessInstallation,
  LinkedRunResult,
  Project,
  ProjectHarnessSettings,
  RerunCheckpointInput,
  RestartCheckpointInput,
  ReviewRecord,
  Run,
  SaveProjectDefaultsInput,
  SendInput,
  WorkspaceSnapshot,
} from './contracts.js';
import type { ProjectContextSnapshot } from './project-context.js';
import { RuntimeHarness } from './runtime-harness.js';
import { reconcileInterruptedRuns } from './runtime-reopen.js';
import {
  approveProjectSetup,
  inspectProject,
  projectSetupSnapshot,
  reconcileProjectSetupCleanup,
} from './project-setup-runtime.js';
import { dispatchOrdinaryRun } from './run-dispatch.js';
import {
  addProject,
  chatEvents,
  createConversation,
  markRead,
  requireConversation,
  requireProject,
  restoreCheckpoint,
  workspaceSnapshot,
} from './runtime-catalog.js';
import { assertOpen, conversationHasBlockingRun } from './runtime-status.js';
import { recoveryHost, dispatchHost, setupHost } from './runtime-hosts.js';
import { executeNativeTurn, finishRun, recordAdapterEvent } from './run-turn.js';
import { closeRuntime, hasActiveWork, stopAllWork, stopRun } from './runtime-lifecycle.js';
export type * from './contracts.js';
export { Store } from './store.js';

export class Runtime {
  readonly store: Store;
  readonly nativeAdmission: NativeAdmission;
  readonly workspaceOwnership: WorkspaceOwnership;
  readonly workspaces: RunWorkspace;
  readonly adapter?: HarnessAdapter;
  private readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  readonly routes: RuntimeHarness;
  private readonly preferences: AppSettings;
  readonly reviews: Reviews;
  readonly checkpoints: Checkpoints;
  readonly pushes: Pushes;
  readonly integrations: Integrations;
  readonly memory: ProjectMemory;
  readonly delegation: DelegationCommands;
  private readonly delegationControls: DelegationControls;
  readonly executionOrigin: ExecutionOrigin | undefined;
  readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void>; run: Run }
  >();
  private readonly listeners = new Set<() => void>();
  accepting = true;
  readonly admission = new Set<string>();
  readonly setupAdmission = new Set<string>();
  constructor(
    adapter: HarnessAdapter | Partial<Record<HarnessId, HarnessAdapter>>,
    dataRoot: string,
    options: {
      push?: PushOptions;
      executionOrigin?: () => ExecutionOrigin | undefined;
      clock?: () => number;
    } = {},
  ) {
    this.executionOrigin = (options.executionOrigin ?? readExecutionOrigin)();
    this.adapters = 'discover' in adapter ? { codex: adapter } : adapter;
    this.adapter = this.adapters.codex;
    this.store = new Store(resolve(dataRoot));
    this.workspaceOwnership = new WorkspaceOwnership(this.store, this.executionOrigin);
    this.workspaces = new RunWorkspace(this.store, this.workspaceOwnership, (run, status, error) =>
      this.finish(run, status, error),
    );
    this.workspaceOwnership.reconcileOnReopen();
    reconstructLegacyWorkspaceOwnership(this.store, this.workspaceOwnership);
    this.nativeAdmission = new NativeAdmission(
      this.store,
      this.executionOrigin ?? {},
      undefined,
      () => this.changed(),
    );
    this.preferences = new AppSettings(this.store.root);
    this.checkpoints = new Checkpoints(this.store);
    this.memory = new ProjectMemory(this.store, () => this.changed());
    const blocking = (id: string) => conversationHasBlockingRun(this.store.runs(), id);
    const workIdle = (id: string) =>
      this.accepting && !this.admission.has(id) && !this.reviews.hasActiveWork(id) && !blocking(id);
    this.routes = new RuntimeHarness(
      this.adapters,
      this.nativeAdmission,
      this.store,
      this.workspaces,
      this.workspaceOwnership,
      (id) => this.admission.has(id) || this.reviews.hasActiveWork(id) || blocking(id),
      () => this.accepting,
      () => this.changed(),
      (id) => this.project(id),
      (id) => this.conversation(id),
      options.clock,
    );
    this.delegation = new DelegationCommands(
      this.store,
      delegationCommandPolicy({
        store: this.store,
        nativeAdmission: this.nativeAdmission,
        adapters: this.adapters,
        isAccepting: () => this.accepting,
        isAdmitting: (conversationId) => this.admission.has(conversationId),
        isRunActive: (runId) => this.active.has(runId),
        reviewsBusy: (conversationId) => this.reviews?.hasActiveWork(conversationId) ?? false,
        pushesBusy: (conversationId) => this.pushes?.hasActiveWork(conversationId) ?? false,
        sessions: (runId) => this.delegation.records.sessions(runId),
      }),
      () => this.changed(),
    );
    this.delegation.records.reconcileUnfinishedSessions();
    this.delegationControls = new DelegationControls(this.store);
    this.delegationControls.reconcileOnReopen();
    new DelegationChecks(this.store).reconcileOnReopen();
    new DelegationTasks(this.store).reconcileOnReopen();
    reconcileInterruptedRuns(this.store, this.delegation, this.delegationControls);
    this.integrations = new Integrations(
      this.store,
      workIdle,
      () => this.changed(),
      this.workspaceOwnership,
    );
    this.pushes = new Pushes(
      this.store,
      workIdle,
      () => this.changed(),
      options.push,
      undefined,
      this.workspaceOwnership,
    );
    this.reviews = new Reviews(
      this.store,
      (run, review, check) =>
        this.nativeAdmission.adapter(run.harness ?? 'codex', this.routes.adapterForRun(run), {
          owner: { kind: 'review', id: review.id },
          runId: run.id,
          reviewId: review.id,
          checkId: check?.id,
          assertCurrent: check?.assertCurrent,
        }),
      (id) => !this.admission.has(id) && !this.pushes.hasActiveWork(id) && !blocking(id),
      () => this.changed(),
      true,
      this.workspaceOwnership,
    );
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changed(): void {
    for (const listener of this.listeners) listener();
  }
  project(id: string): Project {
    return requireProject(this, id);
  }
  conversation(id: string): Conversation {
    return requireConversation(this, id);
  }
  planWorkspace(
    root: string,
    provenance: WorkspaceProvenance,
    plan: () => string,
    held: Map<string, WorkspaceLease>,
    readOnlyPlanning = false,
  ) {
    return this.workspaces.plan(root, provenance, plan, held, readOnlyPlanning);
  }
  inspectExecutable(harness: HarnessId, executable?: string | null): Promise<HarnessInfo> {
    return this.routes.inspectExecutable(harness, executable);
  }
  validateSelection(
    selection: Parameters<RuntimeHarness['validateSelection']>[0],
    info: HarnessInfo,
  ): void {
    this.routes.validateSelection(selection, info);
  }
  validateExecutionMode(mode: NonNullable<Run['executionMode']>, info: HarnessInfo): void {
    this.routes.validateExecutionMode(mode, info);
  }
  runExecutionSnapshot(runId: string) {
    return runExecutionSnapshot(this.store, this.nativeAdmission, runId);
  }
  delegationSnapshot(runId: string): Promise<DelegationSnapshot> {
    return this.delegation.snapshot(runId);
  }
  reviseDelegation(input: ReviseDelegationInput): Promise<DelegationSnapshot> {
    return this.delegation.revise(input);
  }
  rejectDelegation(input: DelegationRevisionInput): Promise<DelegationSnapshot> {
    return this.delegation.reject(input);
  }
  approveDelegation(input: DelegationRevisionInput): Promise<DelegationSnapshot> {
    return this.delegation.approve(input);
  }
  saveDelegationPreset(input: SaveDelegationPresetInput): Promise<DelegationSnapshot> {
    return this.delegation.savePreset(input);
  }
  snapshot(): WorkspaceSnapshot {
    return workspaceSnapshot(this);
  }
  chatEvents(input: ChatEventsInput): ChatEventsResult {
    return chatEvents(this, input);
  }
  restoreCheckpoint(input: CheckpointInput, destination: string): CheckpointRestore {
    return restoreCheckpoint(this, input, destination);
  }
  appSettings(): AppSettingsSnapshot {
    return this.preferences.read();
  }
  saveAppSettings(input: SaveAppSettingsInput): AppSettingsSnapshot {
    assertOpen(this.accepting);
    const result = this.preferences.save(input);
    this.changed();
    return result;
  }
  saveGlobalMemory(input: SaveGlobalMemoryInput): AppSettingsSnapshot {
    assertOpen(this.accepting);
    const result = this.preferences.saveGlobalMemory(input);
    this.changed();
    return result;
  }
  restartRun(input: RestartCheckpointInput): Promise<LinkedRunResult> {
    return recoverLinkedCheckpoint(recoveryHost(this), 'restart', input);
  }
  rerunFromCheckpoint(input: RerunCheckpointInput): Promise<LinkedRunResult> {
    return recoverLinkedCheckpoint(recoveryHost(this), 'rerun', input);
  }
  memorySnapshot(projectId: string): MemorySnapshot {
    return this.memory.snapshot(projectId);
  }
  memoryHistory(projectId: string, reference: LessonRef): LessonVersion[] {
    return this.memory.history(projectId, reference);
  }
  memoryCommand(input: MemoryCommand): MemorySnapshot {
    assertOpen(this.accepting);
    return this.memory.command(input);
  }
  async harnessInstallations(harnessId: HarnessId = 'codex'): Promise<HarnessInstallation[]> {
    return this.routes.installations(harnessId);
  }
  async harness(
    projectId?: string,
    executable?: string,
    harnessId?: HarnessId,
  ): Promise<HarnessInfo> {
    return this.routes.inspect(projectId, executable, harnessId);
  }
  async setExecutionMode(input: ConversationModeInput): Promise<Conversation> {
    return this.routes.setExecutionMode(input);
  }
  integrateConversation(conversationId: string): IntegrationState | null {
    return this.integrations.update(conversationId);
  }
  confirmIntegration(conversationId: string): IntegrationState {
    return this.integrations.confirmResolved(conversationId);
  }
  prepareReview(conversationId: string): ReviewRecord {
    this.integrations.update(conversationId);
    this.integrations.assertReviewable(conversationId);
    return this.reviews.prepare(conversationId);
  }
  verifyReview(reviewId: string): Promise<ReviewRecord> {
    return this.reviews.verify(reviewId);
  }
  approveReview(input: ApproveReviewInput): Promise<ReviewRecord> {
    return this.reviews.approve(input);
  }
  previewPush(reviewId: string): Promise<ReviewRecord> {
    return this.pushes.preview(reviewId);
  }
  approvePush(input: ApprovePushInput): Promise<ReviewRecord> {
    return this.pushes.approve(input);
  }
  checkPush(reviewId: string): Promise<ReviewRecord> {
    return this.pushes.check(reviewId);
  }
  stopPush(reviewId: string): Promise<void> {
    return this.pushes.stop(reviewId);
  }
  stopReview(reviewId: string): Promise<void> {
    return this.reviews.stop(reviewId);
  }
  projectSetup(projectId: string): ProjectSetupSnapshot {
    return projectSetupSnapshot(setupHost(this), projectId);
  }
  reconcileProjectSetupCleanup(projectId: string): ProjectSetupSnapshot {
    return reconcileProjectSetupCleanup(setupHost(this), projectId);
  }
  async inspectProject(input: InspectProjectInput): Promise<Run> {
    return inspectProject(setupHost(this), input);
  }
  approveProjectSetup(input: ApproveProjectSetupInput): ProjectContextSnapshot {
    return approveProjectSetup(setupHost(this), input);
  }
  async saveProjectDefaults(input: SaveProjectDefaultsInput): Promise<ProjectHarnessSettings> {
    return this.routes.saveProjectDefaults(input);
  }
  async setConversationSelection(input: ConversationSelectionInput): Promise<Conversation> {
    return this.routes.setConversationSelection(input);
  }
  addProject(path: string): Project {
    return addProject(this, path);
  }
  createConversation(projectId: string): Conversation {
    return createConversation(this, projectId);
  }
  markRead(conversationId: string): void {
    markRead(this, conversationId);
  }
  async send(input: SendInput): Promise<Run> {
    return this.prepareSend(input);
  }
  prepareSend(
    input: SendInput,
    setup?: { executable?: string; expectedContextRevision: string | null },
  ): Promise<Run> {
    return dispatchOrdinaryRun(dispatchHost(this), input, setup);
  }
  async execute(run: Run, controller: AbortController, lease: WorkspaceLease): Promise<void> {
    return executeNativeTurn(this, run, controller, lease);
  }
  event(run: Run, event: AdapterEvent): void {
    recordAdapterEvent(this, run, event);
  }
  finish(run: Run, status: Run['status'], error?: string): void {
    finishRun(this, run, status, error);
  }
  async stop(runId: string): Promise<void> {
    return stopRun(this, runId);
  }
  hasActiveWork(options: { includeDiscovery?: boolean } = {}): boolean {
    return hasActiveWork(this, options);
  }
  async stopAll(): Promise<void> {
    return stopAllWork(this);
  }
  async close(): Promise<void> {
    return closeRuntime(this);
  }
}
