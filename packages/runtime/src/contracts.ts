import type { RunExecutionSnapshot } from './run-execution.js';
export type { RunExecutionSnapshot } from './run-execution.js';
import type { ExecutionOrigin } from './execution-origin.js';
import type { ParsedSetupProposal } from './project-setup.js';
import type { ProjectContext, ProjectContextSnapshot } from './project-context.js';
export type { ProjectContext, ProjectContextSnapshot } from './project-context.js';
import type {
  AppSettingsSnapshot,
  SaveAppSettingsInput,
  SaveGlobalMemoryInput,
} from './app-settings.js';
export type {
  AppSettingsSnapshot,
  AppPreferences,
  SaveAppSettingsInput,
  SaveGlobalMemoryInput,
} from './app-settings.js';
import type { CheckpointRecord, CheckpointInput, CheckpointRestore } from './checkpoints.js';
export type { CheckpointRecord, CheckpointInput, CheckpointRestore } from './checkpoints.js';
import type { PushRecord, ApprovePushInput } from './pushes.js';
export type { PushRecord, ApprovePushInput } from './pushes.js';
import type { IntegrationState } from './integrations.js';
export type { IntegrationState } from './integrations.js';
import type { MemoryCommand, MemorySnapshot, PreparedMemory } from './memory.js';
import type { LessonRef, LessonVersion } from './lessons.js';
export type { MemoryCommand, MemorySnapshot, PreparedMemory } from './memory.js';
export type { LessonDraft, LessonRef, LessonVersion } from './lessons.js';
import type { GitDeliveryPlan, GitReview } from './git-review.js';
import type { VerificationResult } from './verification.js';
import type {
  DelegationSnapshot,
  DelegationRevisionInput,
  ReviseDelegationInput,
  SaveDelegationPresetInput,
} from './delegation-contracts.js';
export type {
  DelegationSnapshot,
  DelegationRevisionInput,
  ReviseDelegationInput,
  SaveDelegationPresetInput,
} from './delegation-contracts.js';
export type {
  DelegationPlan,
  DelegationAssignment,
  DelegationLimits,
  DelegationRole,
} from './delegation-plan.js';
export type { DelegationPlanRevision, DelegationTask } from './delegation-records.js';

export type RunStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stop-unconfirmed';
export type WorkspaceIdentity = { device: number; inode: number };
export type ExecutionMode = 'read-only' | 'code';
export type HarnessId = 'codex' | 'grok';
export type HarnessSelection = { harness: HarnessId; model: string; effort: string };
export type ProjectHarnessDefaults = HarnessSelection & { executable?: string | null };
export type HarnessRoute = { harness: HarnessId; executable: string };
export type ProjectHarnessSettings = {
  revision: string | null;
  defaults: ProjectHarnessDefaults | null;
  enabledRoutes?: HarnessRoute[];
  error?: string;
};
export type SaveProjectDefaultsInput = {
  projectId: string;
  defaults: ProjectHarnessDefaults;
  enabledRoutes?: HarnessRoute[];
  expectedRevision: string | null;
};
export type ConversationSelectionInput = {
  conversationId: string;
  selection: HarnessSelection | null;
};
export type ConversationModeInput = { conversationId: string; executionMode: ExecutionMode };
export type ApproveReviewInput = { reviewId: string; message: string };
export type ReviewRecord = {
  id: string;
  projectId: string;
  conversationId: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status:
    | 'pending'
    | 'checking'
    | 'stale'
    | 'delivering'
    | 'interrupted'
    | 'delivered'
    | 'failed'
    | 'stop-unconfirmed';
  basis: GitReview;
  push?: PushRecord;
  originOperation?: 'active' | 'cleanup-unconfirmed';
  progress?: { checkId: string; startedAt: string; output: string };
  verification?: VerificationResult;
  deliveryPlan?: GitDeliveryPlan;
  commitOid?: string;
  merged?: boolean;
  cleaned?: boolean;
  error?: string;
};
export type Project = {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  harnessSettings?: ProjectHarnessSettings;
};
export type Conversation = {
  kind?: 'project-setup';
  id: string;
  projectId: string;
  sourceConversationId?: string;
  title: string;
  harness?: HarnessId;
  model: string;
  effort: string;
  executionMode?: ExecutionMode;
  createdAt: string;
  updatedAt: string;
  lastReadSequence: number;
};
export type Run = {
  harnessAuthorizationRevision?: string | null;
  enabledHarnessRoutes?: HarnessRoute[];
  executionOrigin?: ExecutionOrigin;
  workspaceIdentity?: WorkspaceIdentity;
  projectContext?: ProjectContextSnapshot;
  harness?: HarnessId;
  executable?: string;
  executableVersion?: string;
  id: string;
  projectId: string;
  conversationId: string;
  sourceRunId?: string;
  sourceCheckpointDigest?: string;
  recoveryKind?: 'restart' | 'rerun';
  recoveryMessages?: Array<{ role: 'user' | 'assistant'; text: string }>;
  status: RunStatus;
  cleanupUnconfirmed?: boolean;
  checkpoints?: CheckpointRecord[];
  checkpointError?: string;
  memory?: PreparedMemory;
  integration?: IntegrationState;
  model: string;
  effort: string;
  executionMode?: ExecutionMode;
  settingsSource?: 'project' | 'conversation' | 'native';
  projectSettingsRevision?: string | null;
  workspace: string;
  logsPath?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  error?: string;
};
export type Message = {
  id: string;
  conversationId: string;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
};
export type RunEvent = {
  sequence: number;
  runId: string;
  projectId: string;
  conversationId: string;
  at: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
};
export type ChatEventsInput = { conversationId: string; runId: string; afterSequence: number };
export type ChatEventsResult = { run: Run; events: RunEvent[] };
export type WorkspaceSnapshot = {
  projects: Project[];
  conversations: Conversation[];
  runs: Run[];
  messages: Message[];
  events: RunEvent[];
  reviews: ReviewRecord[];
  dataRoot: string;
};
export type HarnessModel = { id: string; name: string; efforts: string[]; defaultEffort: string };
export type HarnessInstallation = {
  harness?: HarnessId;
  executable: string;
  version?: string;
  reason?: string;
};
export type HarnessInfo = {
  cleanupVerified?: boolean;
  applicationTools?: boolean;
  commandLifecycle?: boolean;
  harness?: HarnessId;
  executable?: string;
  available: boolean;
  authenticated: boolean;
  version?: string;
  models: HarnessModel[];
  executionModes?: ExecutionMode[];
  reason?: string;
};
export type AdapterEvent = { type: string; summary: string; data?: Record<string, unknown> };
export type ApplicationToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ApplicationToolRequest = {
  threadId: string;
  turnId: string;
  callId: string;
  requestId: string | number;
  name: string;
  arguments: unknown;
};
export type ApplicationToolResult = { success: boolean; text: string };
export type ApplicationTools = {
  definitions: ApplicationToolDefinition[];
  // Handlers retain mutation and receipt in one synchronous transaction before returning.
  // They do not wait for approval, start workers, or infer the run scope from arguments.
  onRequest: (request: ApplicationToolRequest) => ApplicationToolResult;
};
export type AdapterRun = {
  applicationTools?: ApplicationTools;
  workspaceIdentity?: WorkspaceIdentity;
  executable?: string;
  executableVersion?: string;
  workspace: string;
  model: string;
  effort: string;
  executionMode?: ExecutionMode;
  messages: Pick<Message, 'role' | 'text'>[];
  signal: AbortSignal;
  onEvent: (event: AdapterEvent) => void;
};
/** A harness may report a failed turn after it has confirmed its own native process cleanup. */
export class AdapterRunFailure extends Error {
  readonly cleanupEvidence: Record<string, unknown>;
  constructor(message: string, cleanupEvidence: Record<string, unknown>) {
    super(message);
    this.name = 'AdapterRunFailure';
    let cloned: unknown;
    try {
      cloned = structuredClone(cleanupEvidence);
    } catch {
      throw new Error('Adapter failure cleanup evidence must be cloneable.');
    }
    if (
      !cloned ||
      typeof cloned !== 'object' ||
      Array.isArray(cloned) ||
      !Object.keys(cloned).length
    )
      throw new Error('Adapter failure cleanup evidence must be a nonempty record.');
    let encoded: string;
    try {
      encoded = JSON.stringify(cloned);
    } catch {
      throw new Error('Adapter failure cleanup evidence must be serializable.');
    }
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > 16_384)
      throw new Error('Adapter failure cleanup evidence exceeds 16 KiB.');
    this.cleanupEvidence = cloned as Record<string, unknown>;
  }
}
export type AdapterCommand = {
  executable?: string;
  executableVersion?: string;
  workspace: string;
  workspaceIdentity?: WorkspaceIdentity;
  command: string[];
  signal: AbortSignal;
  onOutput: (text: string) => void;
  onDispatch?: (value: { processId: string }) => void;
};
export type AdapterCommandResult = {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  cleanupVerified: boolean;
  error?: string;
};
export interface HarnessAdapter {
  discover(executable?: string, signal?: AbortSignal): Promise<HarnessInfo>;
  /** Filesystem-only candidate enumeration. Native probes belong to cancellable discover. */
  installations?(): Promise<HarnessInstallation[]>;
  run(input: AdapterRun): Promise<{ status: 'completed' | 'interrupted' | 'stop-unconfirmed' }>;
  runCommand?(input: AdapterCommand): Promise<AdapterCommandResult>;
}
export type ProjectInspection = {
  conversationId: string;
  run: Run;
  proposal?: ParsedSetupProposal;
  error?: string;
  canApprove: boolean;
  approvedRevision?: string;
};
export type ProjectSetupSnapshot = {
  cleanup?: { canReconcile: boolean; reason: string };
  context: ProjectContextSnapshot;
  inspections: ProjectInspection[];
};
export type InspectProjectInput = {
  projectId: string;
  selection: HarnessSelection;
  executable?: string;
  brief: string;
};
export type ApproveProjectSetupInput = {
  projectId: string;
  runId: string;
  proposalRevision: string;
  expectedContextRevision: string | null;
  value: ProjectContext;
};
export type SendInput = {
  conversationId: string;
  text: string;
  harness?: HarnessId;
  model?: string;
  effort?: string;
};
export type RestartCheckpointInput = { runId: string; checkpointDigest: string };
export type RerunCheckpointInput = { runId: string; checkpointDigest: string };
export type LinkedRunResult = { conversation: Conversation; run: Run };
export interface DesktopBridge {
  runExecutionSnapshot(runId: string): Promise<RunExecutionSnapshot>;
  delegationSnapshot(runId: string): Promise<DelegationSnapshot>;
  reviseDelegation(input: ReviseDelegationInput): Promise<DelegationSnapshot>;
  rejectDelegation(input: DelegationRevisionInput): Promise<DelegationSnapshot>;
  approveDelegation(input: DelegationRevisionInput): Promise<DelegationSnapshot>;
  saveDelegationPreset(input: SaveDelegationPresetInput): Promise<DelegationSnapshot>;
  snapshot(): Promise<WorkspaceSnapshot>;
  projectSetup(projectId: string): Promise<ProjectSetupSnapshot>;
  reconcileProjectSetupCleanup(projectId: string): Promise<ProjectSetupSnapshot>;
  inspectProject(input: InspectProjectInput): Promise<Run>;
  approveProjectSetup(input: ApproveProjectSetupInput): Promise<ProjectContextSnapshot>;
  chatEvents(input: ChatEventsInput): Promise<ChatEventsResult>;
  appSettings(): Promise<AppSettingsSnapshot>;
  saveAppSettings(input: SaveAppSettingsInput): Promise<AppSettingsSnapshot>;
  saveGlobalMemory(input: SaveGlobalMemoryInput): Promise<AppSettingsSnapshot>;
  onNavigate(listener: (destination: 'workspace' | 'settings') => void): () => void;
  restoreCheckpoint(input: CheckpointInput): Promise<CheckpointRestore | null>;
  restartRun(input: RestartCheckpointInput): Promise<LinkedRunResult>;
  rerunFromCheckpoint(input: RerunCheckpointInput): Promise<LinkedRunResult>;
  memorySnapshot(projectId: string): Promise<MemorySnapshot>;
  memoryCommand(input: MemoryCommand): Promise<MemorySnapshot>;
  memoryHistory(projectId: string, reference: LessonRef): Promise<LessonVersion[]>;
  harness(projectId?: string, executable?: string, harnessId?: HarnessId): Promise<HarnessInfo>;
  harnessInstallations(harnessId?: HarnessId): Promise<HarnessInstallation[]>;
  addProject(): Promise<Project | null>;
  createConversation(projectId: string): Promise<Conversation>;
  saveProjectDefaults(input: SaveProjectDefaultsInput): Promise<ProjectHarnessSettings>;
  setConversationSelection(input: ConversationSelectionInput): Promise<Conversation>;
  setExecutionMode(input: ConversationModeInput): Promise<Conversation>;
  integrateConversation(conversationId: string): Promise<IntegrationState | null>;
  confirmIntegration(conversationId: string): Promise<IntegrationState>;
  prepareReview(conversationId: string): Promise<ReviewRecord>;
  verifyReview(reviewId: string): Promise<ReviewRecord>;
  approveReview(input: ApproveReviewInput): Promise<ReviewRecord>;
  previewPush(reviewId: string): Promise<ReviewRecord>;
  approvePush(input: ApprovePushInput): Promise<ReviewRecord>;
  checkPush(reviewId: string): Promise<ReviewRecord>;
  stopPush(reviewId: string): Promise<void>;
  stopReview(reviewId: string): Promise<void>;
  send(input: SendInput): Promise<Run>;
  stop(runId: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
