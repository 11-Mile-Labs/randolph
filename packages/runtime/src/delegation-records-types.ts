import type { DelegationPlan } from './delegation-plan-types.js';

export type PlanDisposition = 'draft' | 'ready' | 'superseded' | 'authorized' | 'rejected';
export type DelegationPlanRevision = {
  id: string;
  runId: string;
  revision: number;
  digest: string;
  basis: Record<string, unknown>;
  basisDigest: string;
  requestId: string;
  source: 'proposal' | 'preset';
  plan: DelegationPlan;
  createdAt: string;
  disposition: PlanDisposition;
};
export type DelegationAuthorization = {
  id: string;
  runId: string;
  planId: string;
  digest: string;
  basisDigest: string;
  decision: 'user' | 'yolo' | 'preset';
  presetSaved: boolean;
  createdAt: string;
  revokedAt?: string;
  revokeReason?: string;
};
export type DelegationPresetSave = {
  id: string;
  runId: string;
  planId: string;
  presetId: string;
  digest: string;
  basisDigest: string;
  createdAt: string;
};
export type DelegationSourceSnapshot = {
  checkpointDirectory: string;
  checkpointDigest: string;
  treeOid: string;
  producerTaskId?: string;
};
export type DelegationAttemptResult = {
  summary: string;
  artifacts: string[];
  success: boolean;
  source?: DelegationSourceSnapshot;
};
export type DelegationAttemptWorkspace = {
  path: string;
  identity: { device: number; inode: number };
};
export type DelegationOutputPublication = {
  state: 'intent' | 'completed';
  generation: number;
  source?: DelegationSourceSnapshot;
  createdAt: string;
  updatedAt: string;
};
export type DelegationPreparation = {
  state: 'intent' | 'completed';
  generation: number;
  workspaceId: string;
  source: DelegationSourceSnapshot;
  workspace?: DelegationAttemptWorkspace;
  createdAt: string;
  updatedAt: string;
};
export type DelegationCheck = {
  id: string;
  argv: string[];
  sessionId: string;
  commandId?: string;
  state:
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'passed'
    | 'failed'
    | 'interrupted'
    | 'cleanup-unconfirmed'
    | 'unavailable';
  exitCode?: number | null;
  output?: string;
  truncated?: boolean;
  cleanupConfirmed?: boolean;
  cleanupEvidence?: Record<string, unknown>;
  observedTreeOid?: string;
  error?: string;
};
export type DelegationVerification = {
  input: DelegationSourceSnapshot;
  manifestDigest: string;
  commands: Array<{ id: string; argv: string[] }>;
  checks: DelegationCheck[];
  createdAt: string;
  updatedAt: string;
};
export type DelegationAttempt = {
  id: string;
  generation: number;
  status:
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'cleanup-unconfirmed';
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  controlGeneration?: number;
  source?: DelegationSourceSnapshot;
  contextArtifacts?: string[];
  workspace?: DelegationAttemptWorkspace;
  result?: DelegationAttemptResult;
  preparation?: DelegationPreparation;
  verification?: DelegationVerification;
  outputPublication?: DelegationOutputPublication;
  cleanupConfirmed?: boolean;
  cleanupEvidence?: Record<string, unknown>;
  runtimeRecoveryRequired?: boolean;
  error?: string;
};
export type DelegationTask = {
  id: string;
  runId: string;
  authorizationId: string;
  assignmentId: string;
  dependencies: string[];
  workspaceIdentity?: string;
  contextArtifacts: string[];
  state:
    | 'queued'
    | 'blocked'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'cleanup-unconfirmed';
  blockedReason?: 'terminal-predecessor' | 'synthesis-failed-graph';
  attempts: DelegationAttempt[];
  createdAt: string;
  updatedAt: string;
};
