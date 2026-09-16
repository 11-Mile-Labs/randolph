export type DelegationHarness = 'codex' | 'grok';
export type DelegationMode = 'code' | 'read-only';
export type DelegationRole =
  | 'worker'
  | 'main-integration'
  | 'runtime-verification'
  | 'review'
  | 'main-synthesis';
export type DelegationSource = 'run-basis' | `output:${string}`;
export type DelegationLimits = {
  maxWorkers: number;
  maxParallel: number;
  maxAttempts: number;
  activeMinutes: number;
};
export type DelegationAssignment = {
  id: string;
  task: string;
  role: DelegationRole;
  harness: DelegationHarness;
  executable: string;
  executableVersion: string;
  model: string;
  effort: string;
  rationale: string;
  dependencies: string[];
  source: DelegationSource;
  mode: DelegationMode;
  deliverables: string[];
  completionCriteria: string[];
  producesSource?: boolean;
  integrationInputs?: string[];
  repairAttempts?: number;
};
export type DelegationPlan = {
  schemaVersion: 1;
  id: string;
  revision: number;
  assignments: DelegationAssignment[];
  limits: DelegationLimits;
};
export type DelegationPreset = {
  id: string;
  name: string;
  revision: number;
  plan: DelegationPlan;
  importProvenance?: { source: string; version: string };
};
export type DelegationSettings = {
  routing: 'fast' | 'balanced' | 'thorough';
  defaultPresetId: string | null;
  presets: DelegationPreset[];
};
export type DelegationSelection = Pick<
  DelegationAssignment,
  'harness' | 'executable' | 'executableVersion' | 'model' | 'effort'
>;
export type DelegationRoute = {
  harness: DelegationHarness;
  executable: string;
  version: string;
  models: Array<{ id: string; efforts: string[] }>;
  modes: DelegationMode[];
  enabled: boolean;
  commandCapability: boolean;
};
export type DelegationAvailability = {
  routes: DelegationRoute[];
  mainSelection?: DelegationSelection;
};
export type DelegationValidation = { valid: boolean; errors: string[]; digest?: string };
