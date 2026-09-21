import { isAbsolute } from 'node:path';
import type {
  DelegationAssignment,
  DelegationLimits,
  DelegationPlan,
  DelegationPreset,
  DelegationRole,
  DelegationSettings,
  DelegationSource,
} from './delegation-plan-types.js';
import { validateDelegationPlan } from './delegation-plan-validation.js';
import { readYamlSettings, writeYamlSettings, type YamlSettings } from './yaml-settings.js';

export type {
  DelegationHarness,
  DelegationMode,
  DelegationRole,
  DelegationSource,
  DelegationLimits,
  DelegationAssignment,
  DelegationPlan,
  DelegationPreset,
  DelegationSettings,
  DelegationSelection,
  DelegationRoute,
  DelegationAvailability,
  DelegationValidation,
} from './delegation-plan-types.js';

export const defaultDelegationLimits: DelegationLimits = {
  maxWorkers: 4,
  maxParallel: 2,
  maxAttempts: 1,
  activeMinutes: 20,
};
export const defaultDelegationSettings: DelegationSettings = {
  routing: 'balanced',
  defaultPresetId: null,
  presets: [],
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function known(input: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}.`);
}
function text(value: unknown, label: string, max = 4000): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`${label} must be bounded nonempty text.`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 80);
  if (!/^[a-z][a-z0-9-]*$/u.test(result))
    throw new Error(`${label} must use lowercase letters, digits, and hyphens.`);
  return result;
}
function count(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new Error(`${label} must be a bounded whole number.`);
  return value as number;
}
function textList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum)
    throw new Error(`${label} must be a nonempty bounded list.`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`, 1000));
}
function source(value: unknown): DelegationSource {
  const selected = text(value, 'Assignment source', 100);
  if (selected === 'run-basis' || /^output:[a-z][a-z0-9-]*$/u.test(selected))
    return selected as DelegationSource;
  throw new Error('Assignment source must be run-basis or output:<node-id>.');
}
function parseAssignment(value: unknown): DelegationAssignment {
  const input = record(value, 'Assignment');
  known(
    input,
    [
      'id',
      'task',
      'role',
      'harness',
      'executable',
      'executableVersion',
      'model',
      'effort',
      'rationale',
      'dependencies',
      'source',
      'mode',
      'deliverables',
      'completionCriteria',
      'producesSource',
      'integrationInputs',
      'repairAttempts',
    ],
    'Assignment',
  );
  const role = input.role;
  if (
    typeof role !== 'string' ||
    !['worker', 'main-integration', 'runtime-verification', 'review', 'main-synthesis'].includes(
      role,
    )
  )
    throw new Error('Assignment role is unsupported.');
  const harness = input.harness;
  if (harness !== 'codex' && harness !== 'grok')
    throw new Error('Assignment harness is unsupported.');
  const mode = input.mode;
  if (mode !== 'code' && mode !== 'read-only') throw new Error('Assignment mode is unsupported.');
  if (input.producesSource !== undefined && typeof input.producesSource !== 'boolean')
    throw new Error('producesSource must be true or false.');
  const executable = text(input.executable, 'Assignment executable');
  if (!isAbsolute(executable)) throw new Error('Assignment executable must be an absolute path.');
  return {
    id: id(input.id, 'Assignment ID'),
    task: text(input.task, 'Assignment task'),
    role: role as DelegationRole,
    harness,
    executable,
    executableVersion: text(input.executableVersion, 'Assignment executable version', 200),
    model: text(input.model, 'Assignment model', 200),
    effort: text(input.effort, 'Assignment effort', 32),
    rationale: text(input.rationale, 'Assignment rationale'),
    dependencies: (() => {
      if (!Array.isArray(input.dependencies) || input.dependencies.length > 32)
        throw new Error('Assignment dependencies must be a bounded list.');
      return input.dependencies.map((entry, index) => id(entry, `Assignment dependency ${index}`));
    })(),
    source: source(input.source),
    mode,
    deliverables: textList(input.deliverables, 'Assignment deliverables', 20),
    completionCriteria: textList(input.completionCriteria, 'Assignment completion criteria', 20),
    ...(input.producesSource === undefined ? {} : { producesSource: input.producesSource }),
    ...(input.integrationInputs === undefined
      ? {}
      : {
          integrationInputs: textList(input.integrationInputs, 'Integration inputs', 16).map(
            (entry, index) => id(entry, `Integration input ${index}`),
          ),
        }),
    ...(input.repairAttempts === undefined
      ? {}
      : { repairAttempts: count(input.repairAttempts, 'Assignment repair attempts', 10) }),
  };
}
function parseLimits(value: unknown): DelegationLimits {
  const input = record(value, 'Delegation limits');
  known(input, ['maxWorkers', 'maxParallel', 'maxAttempts', 'activeMinutes'], 'Delegation limits');
  const maxWorkers = count(input.maxWorkers, 'maxWorkers', 16),
    maxParallel = count(input.maxParallel, 'maxParallel', 16),
    maxAttempts = count(input.maxAttempts, 'maxAttempts', 10),
    activeMinutes = count(input.activeMinutes, 'activeMinutes', 480);
  if (!maxWorkers || !maxParallel || !maxAttempts || !activeMinutes || maxParallel > maxWorkers)
    throw new Error('Delegation limits must be positive and maxParallel cannot exceed maxWorkers.');
  return { maxWorkers, maxParallel, maxAttempts, activeMinutes };
}
export function parseDelegationDraft(value: unknown): DelegationPlan {
  const input = record(value, 'Delegation plan');
  known(input, ['schemaVersion', 'id', 'revision', 'assignments', 'limits'], 'Delegation plan');
  if (input.schemaVersion !== 1) throw new Error('Delegation plan requires schemaVersion: 1.');
  const revision = count(input.revision, 'Plan revision', 1_000_000);
  if (
    !revision ||
    !Array.isArray(input.assignments) ||
    !input.assignments.length ||
    input.assignments.length > 24
  )
    throw new Error('Delegation plan requires 1 to 24 assignments and a positive revision.');
  return {
    schemaVersion: 1 as const,
    id: id(input.id, 'Plan ID'),
    revision,
    assignments: input.assignments.map(parseAssignment),
    limits: parseLimits(input.limits),
  };
}
export function parseDelegationPlan(value: unknown): DelegationPlan {
  const plan = parseDelegationDraft(value);
  const checked = validateDelegationPlan(plan);
  if (!checked.valid) throw new Error(checked.errors.join(' '));
  return plan;
}
export { delegationPlanDigest } from './delegation-plan-digest.js';
export { validateDelegationPlan } from './delegation-plan-validation.js';
function parsePreset(value: unknown): DelegationPreset {
  const input = record(value, 'Delegation preset');
  const provenance = input.importProvenance;
  known(input, ['id', 'name', 'revision', 'plan', 'importProvenance'], 'Delegation preset');
  let importProvenance: DelegationPreset['importProvenance'];
  if (provenance !== undefined) {
    const item = record(provenance, 'Preset import provenance');
    importProvenance = {
      source: text(item.source, 'Preset import source'),
      version: text(item.version, 'Preset import version', 200),
    };
  }
  const revision = count(input.revision, 'Preset revision', 1_000_000);
  if (!revision) throw new Error('Preset revision must be positive.');
  return {
    id: id(input.id, 'Preset ID'),
    name: text(input.name, 'Preset name', 120),
    revision,
    plan: parseDelegationPlan(input.plan),
    ...(importProvenance ? { importProvenance } : {}),
  };
}
export function parseDelegationSettings(value: unknown): DelegationSettings {
  const input = record(value, 'Delegation settings');
  const routing = input.routing;
  if (routing !== 'fast' && routing !== 'balanced' && routing !== 'thorough')
    throw new Error('Delegation routing must be fast, balanced, or thorough.');
  if (!Array.isArray(input.presets) || input.presets.length > 50)
    throw new Error('Delegation presets must be a bounded list.');
  const presets = input.presets.map(parsePreset),
    ids = new Set(presets.map((preset) => preset.id));
  if (ids.size !== presets.length) throw new Error('Delegation preset IDs must be unique.');
  const defaultPresetId =
    input.defaultPresetId === undefined || input.defaultPresetId === null
      ? null
      : id(input.defaultPresetId, 'Default preset ID');
  if (defaultPresetId && !ids.has(defaultPresetId))
    throw new Error('Default preset must identify a configured preset.');
  return { routing, presets, defaultPresetId };
}
export function readDelegationSettings(root: string): YamlSettings<DelegationSettings> {
  return readYamlSettings(
    root,
    'config.delegation.yaml',
    parseDelegationSettings,
    structuredClone(defaultDelegationSettings),
  );
}
export function writeDelegationSettings(
  root: string,
  value: DelegationSettings,
  expectedRevision: string | null,
): YamlSettings<DelegationSettings> {
  return writeYamlSettings(
    root,
    'config.delegation.yaml',
    value,
    expectedRevision,
    parseDelegationSettings,
  );
}
