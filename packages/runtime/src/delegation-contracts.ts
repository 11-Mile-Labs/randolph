import type { DelegationPlan, DelegationSettings } from './delegation-plan.js';
import type { DelegationPlanRevision, DelegationTask } from './delegation-records.js';

export type DelegationRevisionInput = {
  runId: string;
  planId: string;
  digest: string;
  basisDigest: string;
};
export type ReviseDelegationInput = DelegationRevisionInput & { plan: DelegationPlan };
export type SaveDelegationPresetInput = DelegationRevisionInput & {
  presetId: string;
  name: string;
  expectedSettingsRevision: string | null;
};
export type DelegationSnapshot = {
  runId: string;
  plan?: DelegationPlanRevision;
  history: Array<Pick<DelegationPlanRevision, 'id' | 'revision' | 'disposition' | 'createdAt'>>;
  tasks: DelegationTask[];
  validationErrors: string[];
  blockedReasons: string[];
  canEdit: boolean;
  canApprove: boolean;
  presetSaveWarnings: string[];
  settings: { revision: string | null; value: DelegationSettings; error?: string };
};
