import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as validation from '../dist/validation.js';
const { parseSend, parseId } = validation;
test('IPC accepts only scoped message commands, never arbitrary paths or oversized payloads', () => {
  const conversationId = '10000000-0000-0000-0000-000000000001';
  const message = { conversationId, text: 'Review this project', model: 'model', effort: 'low' };
  assert.deepEqual(parseSend(message), message);
  for (const value of [null, [], { ...message, conversationId: '../other' }, { ...message, text: 'x'.repeat(64001) }, { ...message, model: {} }]) assert.throws(() => parseSend(value));
  assert.throws(() => parseId('/tmp/repo'));
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
