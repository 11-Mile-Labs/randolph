import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSend, parseId } from '../dist/validation.js';
test('IPC accepts only scoped message commands, never arbitrary paths or oversized payloads', () => {
  const conversationId = '10000000-0000-0000-0000-000000000001';
  const message = { conversationId, text: 'Review this project', model: 'model', effort: 'low' };
  assert.deepEqual(parseSend(message), message);
  for (const value of [null, [], { ...message, conversationId: '../other' }, { ...message, text: 'x'.repeat(64001) }, { ...message, model: {} }]) assert.throws(() => parseSend(value));
  assert.throws(() => parseId('/tmp/repo'));
});
