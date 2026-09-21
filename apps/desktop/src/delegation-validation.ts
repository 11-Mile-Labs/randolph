import { parseDelegationDraft } from '@randolph/runtime/delegation-plan';
import type {
  DelegationRevisionInput,
  ReviseDelegationInput,
  SaveDelegationPresetInput,
} from '@randolph/runtime/contracts';

const MAX_JSON_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PRESET_ID = /^[a-z][a-z0-9-]*$/u;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function fields(input: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(input);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(input, key)) ||
    actual.some((key) => !expected.includes(key))
  )
    throw new Error(`${label} must contain exactly its supported fields.`);
}
function jsonSize(value: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('Delegation request must be JSON serializable.');
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES)
    throw new Error('Delegation request exceeds 64 KiB.');
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} must be a UUID.`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value))
    throw new Error(`${label} must be a 64-character lowercase SHA-256 digest.`);
  return value;
}
function revision(input: unknown, label: string): DelegationRevisionInput {
  jsonSize(input);
  const value = object(input, label);
  fields(value, ['runId', 'planId', 'digest', 'basisDigest'], label);
  return {
    runId: uuid(value.runId, 'Run ID'),
    planId: uuid(value.planId, 'Plan ID'),
    digest: digest(value.digest, 'Plan digest'),
    basisDigest: digest(value.basisDigest, 'Plan basis digest'),
  };
}

export function parseReviseDelegation(input: unknown): ReviseDelegationInput {
  jsonSize(input);
  const value = object(input, 'Delegation revision');
  fields(value, ['runId', 'planId', 'digest', 'basisDigest', 'plan'], 'Delegation revision');
  const base = revision(
    {
      runId: value.runId,
      planId: value.planId,
      digest: value.digest,
      basisDigest: value.basisDigest,
    },
    'Delegation revision',
  );
  return { ...base, plan: parseDelegationDraft(value.plan) };
}
export function parseRejectDelegation(input: unknown): DelegationRevisionInput {
  return revision(input, 'Delegation rejection');
}
export function parseApproveDelegation(input: unknown): DelegationRevisionInput {
  return revision(input, 'Delegation approval');
}
export function parseSaveDelegationPreset(input: unknown): SaveDelegationPresetInput {
  jsonSize(input);
  const value = object(input, 'Delegation preset save');
  fields(
    value,
    ['runId', 'planId', 'digest', 'basisDigest', 'presetId', 'name', 'expectedSettingsRevision'],
    'Delegation preset save',
  );
  const base = revision(
    {
      runId: value.runId,
      planId: value.planId,
      digest: value.digest,
      basisDigest: value.basisDigest,
    },
    'Delegation preset save',
  );
  if (
    typeof value.presetId !== 'string' ||
    value.presetId.length > 80 ||
    !PRESET_ID.test(value.presetId)
  )
    throw new Error('Preset ID must use lowercase letters, digits, and hyphens.');
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name !== value.name.trim() ||
    value.name.length > 120 ||
    Array.from(value.name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('Preset name must be bounded nonempty text.');
  if (
    value.expectedSettingsRevision !== null &&
    (typeof value.expectedSettingsRevision !== 'string' ||
      !DIGEST.test(value.expectedSettingsRevision))
  )
    throw new Error('Settings revision must be a digest or null.');
  return {
    ...base,
    presetId: value.presetId,
    name: value.name,
    expectedSettingsRevision: value.expectedSettingsRevision,
  };
}
