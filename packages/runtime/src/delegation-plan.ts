import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { readYamlSettings, writeYamlSettings, type YamlSettings } from './yaml-settings.js';

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
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function delegationPlanDigest(value: DelegationPlan): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function graphErrors(plan: DelegationPlan): string[] {
  const errors: string[] = [],
    nodes = new Map(plan.assignments.map((node) => [node.id, node]));
  if (nodes.size !== plan.assignments.length) errors.push('Assignment IDs must be unique.');
  const roles = (role: DelegationRole) => plan.assignments.filter((node) => node.role === role);
  if (!roles('worker').length) errors.push('A delegation plan requires a worker assignment.');
  if (roles('main-synthesis').length !== 1)
    errors.push('A delegation plan requires exactly one main-synthesis assignment.');
  const hasCode = plan.assignments.some((node) => node.mode === 'code');
  for (const role of ['main-integration', 'runtime-verification'] as const)
    if (hasCode && roles(role).length !== 1)
      errors.push(`A code delegation plan requires exactly one ${role} assignment.`);
    else if (!hasCode && roles(role).length)
      errors.push(`${role} is not permitted in a read-only delegation plan.`);
  if (roles('worker').length + roles('review').length > plan.limits.maxWorkers)
    errors.push('Worker and review assignments exceed maxWorkers.');
  for (const node of plan.assignments) {
    if (new Set(node.dependencies).size !== node.dependencies.length)
      errors.push(`${node.id} has duplicate dependencies.`);
    for (const dependency of node.dependencies)
      if (!nodes.has(dependency))
        errors.push(`${node.id} depends on unknown assignment ${dependency}.`);
    if (node.source.startsWith('output:')) {
      const producerId = node.source.slice('output:'.length),
        producer = nodes.get(producerId);
      if (!producer) errors.push(`${node.id} selects an unknown source output.`);
      else {
        if (!node.dependencies.includes(producerId))
          errors.push(`${node.id} must explicitly depend on its source output ${producerId}.`);
        if (!producer.producesSource)
          errors.push(
            `${node.id} selects ${producerId}, which does not produce an immutable source snapshot.`,
          );
      }
    }
    if (node.role === 'worker' && node.mode === 'code' && !node.producesSource)
      errors.push(`${node.id} is a code writer and must produce an immutable source snapshot.`);
    if (node.role === 'main-integration') {
      if (node.mode !== 'code' || !node.producesSource || !node.integrationInputs?.length)
        errors.push(
          'Main integration must be a code writer, produce a source snapshot, and declare explicit writer integration inputs.',
        );
      if (
        node.integrationInputs &&
        new Set(node.integrationInputs).size !== node.integrationInputs.length
      )
        errors.push('Main integration cannot repeat an integration input.');
      for (const input of node.integrationInputs ?? []) {
        const writer = nodes.get(input);
        if (!writer || writer.role !== 'worker' || writer.mode !== 'code' || !writer.producesSource)
          errors.push(
            `Integration input ${input} must identify a code worker immutable source output.`,
          );
        if (!node.dependencies.includes(input))
          errors.push(`Main integration must explicitly depend on integration input ${input}.`);
      }
    }
    if (
      node.role === 'runtime-verification' &&
      (!node.producesSource ||
        node.mode !== 'code' ||
        !node.source.startsWith('output:') ||
        nodes.get(node.source.slice(7))?.role !== 'main-integration')
    )
      errors.push(
        'Runtime verification must check the main integration output and produce a checked source snapshot.',
      );
    if (node.role === 'review' && node.mode !== 'read-only')
      errors.push('Review must be read-only.');
    if (
      node.role === 'review' &&
      hasCode &&
      (!node.source.startsWith('output:') ||
        nodes.get(node.source.slice(7))?.role !== 'runtime-verification')
    )
      errors.push(
        'Code review must follow runtime verification; code review before checks is invalid.',
      );
    if (node.role === 'main-synthesis' && (node.mode !== 'read-only' || node.producesSource))
      errors.push('Main synthesis must be read-only and cannot produce a source snapshot.');
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (node: DelegationAssignment): void => {
    if (visiting.has(node.id)) {
      errors.push('Assignment dependencies must be acyclic.');
      return;
    }
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    node.dependencies.forEach((dependency) => {
      const next = nodes.get(dependency);
      if (next) visit(next);
    });
    visiting.delete(node.id);
    visited.add(node.id);
  };
  plan.assignments.forEach(visit);
  if (hasCode) {
    const integration = roles('main-integration')[0],
      verification = roles('runtime-verification')[0],
      synthesis = roles('main-synthesis')[0];
    for (const writer of roles('worker').filter((node) => node.mode === 'code'))
      if (!integration?.integrationInputs?.includes(writer.id))
        errors.push(
          `Code worker ${writer.id} is not included in the final integration source lineage.`,
        );
    if (
      synthesis &&
      (!synthesis.source.startsWith('output:') || synthesis.source.slice(7) !== verification?.id)
    )
      errors.push(
        'Code-plan synthesis must use the final checked verification output as its source.',
      );
  }
  const synthesis = roles('main-synthesis')[0];
  if (synthesis) {
    const ancestors = new Set<string>();
    const collect = (node: DelegationAssignment): void => {
      for (const dependency of node.dependencies)
        if (!ancestors.has(dependency)) {
          ancestors.add(dependency);
          const predecessor = nodes.get(dependency);
          if (predecessor) collect(predecessor);
        }
    };
    collect(synthesis);
    for (const node of plan.assignments)
      if (node.role !== 'main-synthesis' && !ancestors.has(node.id))
        errors.push(`Main synthesis must wait for settled assignment ${node.id}.`);
  }
  return errors;
}
export function validateDelegationPlan(
  plan: DelegationPlan,
  availability?: DelegationAvailability,
): DelegationValidation {
  const errors = graphErrors(plan);
  const integration = plan.assignments.find((node) => node.role === 'main-integration');
  const verification = plan.assignments.find((node) => node.role === 'runtime-verification');
  if (
    integration &&
    verification &&
    (verification.harness !== integration.harness ||
      verification.executable !== integration.executable ||
      verification.executableVersion !== integration.executableVersion)
  )
    errors.push(
      'Runtime verification must use the same native harness and executable as main integration.',
    );
  if (availability)
    for (const assignment of plan.assignments) {
      const route = availability.routes.find(
        (candidate) =>
          candidate.harness === assignment.harness &&
          candidate.executable === assignment.executable &&
          candidate.version === assignment.executableVersion,
      );
      if (!route || !route.enabled) {
        errors.push(`${assignment.id} uses an unavailable or disabled route.`);
        continue;
      }
      const model = route.models.find((candidate) => candidate.id === assignment.model);
      if (!model || !model.efforts.includes(assignment.effort))
        errors.push(`${assignment.id} uses an unavailable model or effort.`);
      if (!route.modes.includes(assignment.mode))
        errors.push(`${assignment.id} uses an unavailable execution mode.`);
      if (assignment.role === 'runtime-verification' && !route.commandCapability)
        errors.push(`${assignment.id} requires a verified native command capability.`);
    }
  if (availability?.mainSelection) {
    const selection = availability.mainSelection;
    const exact = (assignment: DelegationAssignment) =>
      assignment.harness === selection.harness &&
      assignment.executable === selection.executable &&
      assignment.executableVersion === selection.executableVersion &&
      assignment.model === selection.model &&
      assignment.effort === selection.effort;
    for (const assignment of plan.assignments.filter(
      (node) => node.role === 'main-integration' || node.role === 'main-synthesis',
    ))
      if (!exact(assignment))
        errors.push(`${assignment.id} must use the frozen selected main-agent identity.`);
  }
  return errors.length
    ? { valid: false, errors }
    : { valid: true, errors: [], digest: delegationPlanDigest(plan) };
}
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
