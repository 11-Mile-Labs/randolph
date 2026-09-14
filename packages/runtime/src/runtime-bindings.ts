import type { WorkspaceLease, WorkspaceProvenance } from './workspace-leases.js';
import type { Store } from './store.js';
import type { RunWorkspace } from './run-workspace.js';
import type { WorkspaceOwnership } from './workspace-ownership.js';
import type { RuntimeHarness } from './runtime-harness.js';
import type { ProjectMemory } from './memory.js';
import type { Checkpoints } from './checkpoints.js';
import type { Reviews } from './reviews.js';
import type { Pushes } from './pushes.js';
import type { Integrations } from './integrations.js';
import type { NativeAdmission } from './native-admission.js';
import type { DelegationCommands } from './delegation-commands.js';
import type { ExecutionOrigin } from './execution-origin.js';
import type {
  AdapterEvent,
  Conversation,
  HarnessId,
  HarnessInfo,
  HarnessSelection,
  Project,
  Run,
  SendInput,
} from './contracts.js';

export type ActiveRun = { controller: AbortController; done: Promise<void>; run: Run };

export type RuntimeBindings = {
  accepting: boolean;
  store: Store;
  workspaces: RunWorkspace;
  workspaceOwnership: WorkspaceOwnership;
  routes: RuntimeHarness;
  memory: ProjectMemory;
  checkpoints: Checkpoints;
  reviews: Reviews;
  pushes: Pushes;
  integrations: Integrations;
  nativeAdmission: NativeAdmission;
  delegation: DelegationCommands;
  executionOrigin: ExecutionOrigin | undefined;
  admission: Set<string>;
  setupAdmission: Set<string>;
  active: Map<string, ActiveRun>;
  conversation(id: string): Conversation;
  project(id: string): Project;
  createConversation(projectId: string): Conversation;
  planWorkspace(
    root: string,
    provenance: WorkspaceProvenance,
    plan: () => string,
    held: Map<string, WorkspaceLease>,
    readOnlyPlanning?: boolean,
  ): { parent: WorkspaceLease; lease: WorkspaceLease; workspace: string };
  execute(run: Run, controller: AbortController, lease: WorkspaceLease): Promise<void>;
  finish(run: Run, status: Run['status'], error?: string): void;
  event(run: Run, event: AdapterEvent): void;
  changed(): void;
  prepareSend(
    input: SendInput,
    setup?: { executable?: string; expectedContextRevision: string | null },
  ): Promise<Run>;
  inspectExecutable(harness: HarnessId, executable?: string | null): Promise<HarnessInfo>;
  validateSelection(selection: HarnessSelection, info: HarnessInfo): void;
  validateExecutionMode(mode: NonNullable<Run['executionMode']>, info: HarnessInfo): void;
};
