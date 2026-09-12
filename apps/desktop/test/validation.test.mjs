import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as validation from '../dist/validation.js';
const { parseSend, parseId, parseChatEvents } = validation;
test('IPC accepts only scoped message commands, never arbitrary paths or oversized payloads', () => {
  const conversationId = '10000000-0000-0000-0000-000000000001';
  const message = { conversationId, text: 'Review this project', model: 'model', effort: 'low' };
  assert.deepEqual(parseSend(message), message);
  for (const value of [null, [], { ...message, conversationId: '../other' }, { ...message, text: 'x'.repeat(64001) }, { ...message, model: {} }]) assert.throws(() => parseSend(value));
  assert.throws(() => parseId('/tmp/repo'));
});

test('chat event IPC validates scoped IDs and nonnegative integer cursors', () => {
  const conversationId = '10000000-0000-0000-0000-000000000001';
  const runId = '10000000-0000-0000-0000-000000000002';
  assert.deepEqual(parseChatEvents({ conversationId, runId, afterSequence: 12 }), { conversationId, runId, afterSequence: 12 });
  for (const value of [null, { conversationId, runId, afterSequence: -1 }, { conversationId, runId, afterSequence: 1.5 }, { conversationId, runId, afterSequence: '12' }, { conversationId: '/tmp/run', runId, afterSequence: 0 }]) assert.throws(() => parseChatEvents(value));
});

test('settings IPC validates scoped identities, paired selections and expected revisions', () => {
  const projectId = '10000000-0000-0000-0000-000000000001';
  const defaults = { harness: 'codex', model: 'model-a', effort: 'low' };
  const save = { projectId, defaults, expectedRevision: null };
  assert.deepEqual(validation.parseProjectDefaults(save), save);
  assert.deepEqual(validation.parseConversationSelection({ conversationId: projectId, selection: null }), { conversationId: projectId, selection: null });
  assert.deepEqual(parseSend({ conversationId: projectId, text: 'Use saved settings' }), { conversationId: projectId, text: 'Use saved settings' });
  for (const value of [null, [], { ...save, projectId: '/tmp/project' }, { ...save, expectedRevision: 'stale' }, { ...save, defaults: { ...defaults, harness: 'other' } }, { ...save, defaults: { ...defaults, model: '' } }]) {
    assert.throws(() => validation.parseProjectDefaults(value));
  }
  for (const selection of [undefined, {}, { ...defaults, effort: 'x'.repeat(33) }, { ...defaults, model: [] }]) {
    assert.throws(() => validation.parseConversationSelection({ conversationId: projectId, selection }));
  }
  assert.throws(() => parseSend({ conversationId: projectId, text: 'Partial selection', model: 'model-a' }));
});

test('coding IPC accepts only explicit execution modes and review-scoped approval messages', () => {
  const id = '10000000-0000-0000-0000-000000000001';
  assert.deepEqual(validation.parseMode({ conversationId: id, executionMode: 'code' }), { conversationId: id, executionMode: 'code' });
  assert.deepEqual(validation.parseReviewApproval({ reviewId: id, message: 'Apply reviewed changes' }), { reviewId: id, message: 'Apply reviewed changes' });
  for (const input of [{ conversationId: id, executionMode: 'yolo' }, { conversationId: '/tmp/repo', executionMode: 'code' }]) assert.throws(() => validation.parseMode(input));
  for (const input of [{ reviewId: id, message: '' }, { reviewId: id, message: 'x'.repeat(16001) }, { reviewId: id, message: 'nul\0byte' }, { reviewId: '../review', message: 'message' }]) assert.throws(() => validation.parseReviewApproval(input));
});


test('project CLI IPC preserves explicit choices and rejects relative paths', () => {
  const input = { projectId: '10000000-0000-0000-0000-000000000001', defaults: { harness: 'codex', model: 'm', effort: 'low', executable: '/opt/example/codex' }, expectedRevision: null };
  assert.deepEqual(validation.parseProjectDefaults(input), input);
  assert.throws(() => validation.parseProjectDefaults({ ...input, defaults: { ...input.defaults, executable: 'relative/codex' } }));
  assert.deepEqual(validation.parseProjectDefaults({ ...input, defaults: { ...input.defaults, executable: null } }).defaults.executable, null);
});

test('harness IPC accepts only the bounded Codex and Grok catalog', () => {
  assert.equal(validation.parseHarnessId('codex'), 'codex');
  assert.equal(validation.parseHarnessId('grok'), 'grok');
  assert.deepEqual(validation.parseHarnessRequest({ harness: 'grok' }), { harness: 'grok' });
  for (const value of ['claude', '', null, 42]) assert.throws(() => validation.parseHarnessId(value));
  assert.throws(() => validation.parseHarnessRequest({ harness: 'claude' }));
});
