import type { NativeOperationOwner } from './native-operation-records.js';
import type { CapacityQueueReason, NativeSessionRole } from './session-capacity.js';

export type NativeAdmissionContext = {
  owner: NativeOperationOwner;
  runId?: string;
  sessionId?: string;
  reviewId?: string;
  checkId?: string;
  generation?: number;
  role?: NativeSessionRole;
  authorizationId?: string;
  workerParallelLimit?: number;
  priority?: () => number;
  assertCurrent?: () => void;
  onAdmitted?: () => void;
  queued?: (reason: CapacityQueueReason) => void;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
};
export type NativeAdmissionCleanup = {
  status: 'completed' | 'failed' | 'interrupted';
  confirmed: boolean;
  evidence: Record<string, unknown>;
  identity?: { executable: string; version: string };
};
