import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  parseApproveDelegation,
  parseRejectDelegation,
  parseReviseDelegation,
  parseSaveDelegationPreset,
} from '../dist/delegation-validation.js';

const digest = 'a'.repeat(64);
const revision = () => ({
  runId: randomUUID(),
  planId: randomUUID(),
  digest,
  basisDigest: 'b'.repeat(64),
});
function plan() {
  return {
    schemaVersion: 1,
    id: 'desktop-draft',
    revision: 1,
    limits: { maxWorkers: 2, maxParallel: 1, maxAttempts: 1, activeMinutes: 20 },
    assignments: [
      {
        id: 'worker',
        task: 'Research',
        role: 'worker',
        harness: 'codex',
        executable: '/opt/codex',
        executableVersion: '1',
        model: 'model',
        effort: 'low',
        rationale: 'Evidence',
        dependencies: ['synthesis'],
        source: 'run-basis',
        mode: 'read-only',
        deliverables: ['Notes'],
        completionCriteria: ['Cited'],
      },
      {
        id: 'synthesis',
        task: 'Synthesize',
        role: 'main-synthesis',
        harness: 'codex',
        executable: '/opt/codex',
        executableVersion: '1',
        model: 'model',
        effort: 'low',
        rationale: 'Conclusion',
        dependencies: ['worker'],
        source: 'output:worker',
        mode: 'read-only',
        deliverables: ['Answer'],
        completionCriteria: ['Complete'],
      },
    ],
  };
}

test('delegation revision IPC retains a bounded graph-invalid draft for later correction', () => {
  const input = { ...revision(), plan: plan() };
  assert.deepEqual(parseReviseDelegation(input), input);
});

test('delegation IPC rejects forged fields, stale identities, malformed plans, and non-JSON payloads', () => {
  const input = { ...revision(), plan: plan() };
  for (const value of [
    { ...input, unexpected: true },
    { ...input, runId: '../other-run' },
    { ...input, digest: 'stale' },
    { ...input, planId: 'not-a-uuid' },
    { ...input, plan: { ...input.plan, unsupported: true } },
    { ...input, plan: { ...input.plan, assignments: [] } },
  ])
    assert.throws(() => parseReviseDelegation(value));
  const circular = { ...input };
  circular.self = circular;
  assert.throws(() => parseReviseDelegation(circular));
});

test('delegation approval, rejection, and preset commands require exact bounded records', () => {
  const input = revision();
  assert.deepEqual(parseApproveDelegation(input), input);
  assert.deepEqual(parseRejectDelegation(input), input);
  const preset = {
    ...input,
    presetId: 'daily-code',
    name: 'Daily code',
    expectedSettingsRevision: null,
  };
  assert.deepEqual(parseSaveDelegationPreset(preset), preset);
  for (const value of [
    { ...preset, expectedSettingsRevision: 'old' },
    { ...preset, presetId: 'Daily Code' },
    { ...preset, name: 'x'.repeat(121) },
    { ...preset, name: ' Name ' },
    { ...preset, extra: true },
  ])
    assert.throws(() => parseSaveDelegationPreset(value));
  assert.throws(() => parseApproveDelegation({ ...input, basisDigest: 'stale' }));
  assert.throws(() => parseRejectDelegation({ ...input, extra: true }));
});

test('delegation IPC caps serialized requests at 64 KiB', () => {
  const input = { ...revision(), plan: plan() };
  input.plan.assignments[0].task = 'x'.repeat(65_000);
  assert.throws(() => parseReviseDelegation(input), /64 KiB/);
});
