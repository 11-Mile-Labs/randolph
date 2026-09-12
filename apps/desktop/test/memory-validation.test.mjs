import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseMemoryCommand } from '../dist/memory-validation.js';
import { parseCheckpoint, parsePushApproval } from '../dist/validation.js';
test('memory and push IPC reject invalid scope identities, versions, and actions', () => {
  const projectId = randomUUID(); const reference = { lessonId: randomUUID(), version: 1 };
  assert.deepEqual(parseMemoryCommand({ projectId, action: 'approve', references: [reference] }), { projectId, action: 'approve', references: [reference] });
  for (const value of [{ projectId, action: 'exec', command: 'touch file' }, { projectId, action: 'approve', references: [{ ...reference, version: 0 }] }, { projectId, action: 'pin', reference, pinned: 'yes' }, { projectId, action: 'settings', scope: 'elsewhere', value: {}, expectedRevision: null }]) assert.throws(() => parseMemoryCommand(value));
  assert.throws(() => parsePushApproval({ reviewId: randomUUID(), revision: 'unscoped' }));
  const approval = { reviewId: randomUUID(), revision: 'f'.repeat(64) };
  assert.deepEqual(parsePushApproval(approval), approval);
});

test('checkpoint IPC accepts a retained digest and run identity, never a renderer destination', () => {
  const input = { runId: randomUUID(), digest: 'a'.repeat(64) };
  assert.deepEqual(parseCheckpoint({ ...input, destination: '/untrusted' }), input);
  assert.throws(() => parseCheckpoint({ ...input, digest: '../manifest' }));
  assert.throws(() => parseCheckpoint({ ...input, runId: '/path' }));
});
