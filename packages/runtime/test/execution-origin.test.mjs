import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupReconciliationReason, parseExecutionOrigin } from '../dist/execution-origin.js';

const hostHash = '3d08203dfabf0ce675ca104a5c11a52061c042b08731c56ae1ecb43272757e98';
const boot = 'fedcba98-7654-3210-fedc-ba9876543210';

test('parses Darwin system output into a versioned origin without retaining the hardware identifier', () => {
  const origin = parseExecutionOrigin(
    'darwin',
    '    | |   "IOPlatformUUID" = "01234567-89AB-CDEF-0123-456789ABCDEF"\n',
    `${boot}\n`,
  );

  assert.deepEqual(origin, { version: 1, hostIdHash: hostHash, bootSessionId: boot });
  assert.equal(JSON.stringify(origin).includes('01234567-89AB-CDEF-0123-456789ABCDEF'), false);
});

test('fails closed when execution-origin system output is unsupported or malformed', () => {
  const validIoreg = '"IOPlatformUUID" = "01234567-89ab-cdef-0123-456789abcdef"\n';
  const validBoot = `${boot}\n`;

  for (const [platform, ioreg, session] of [
    ['linux', validIoreg, validBoot],
    ['darwin', '"IOPlatformUUID" = "not-a-uuid"\n', validBoot],
    ['darwin', `${validIoreg}${validIoreg}`, validBoot],
    ['darwin', validIoreg, 'not-a-uuid\n'],
  ]) assert.equal(parseExecutionOrigin(platform, ioreg, session), undefined);
});

test('permits cleanup reconciliation only after a verified reboot on the same host', () => {
  const recorded = { version: 1, hostIdHash: hostHash, bootSessionId: '01234567-89ab-cdef-0123-456789abcdef' };
  const current = { version: 1, hostIdHash: hostHash, bootSessionId: boot };

  assert.equal(cleanupReconciliationReason(recorded, current), null);
  assert.match(cleanupReconciliationReason(undefined, current), /original Mac.*missing.*malformed/i);
  assert.match(cleanupReconciliationReason(recorded, undefined), /current.*unavailable/i);
  assert.match(cleanupReconciliationReason(recorded, { ...current, hostIdHash: '0'.repeat(64) }), /original Mac/i);
  assert.match(cleanupReconciliationReason(recorded, { ...recorded }), /Restart.*original Mac/i);
  assert.match(cleanupReconciliationReason(recorded, { version: 2, hostIdHash: hostHash, bootSessionId: boot }), /current Mac.*malformed/i);
});
