import assert from 'node:assert/strict';
import test from 'node:test';
import { directReceipt, callbackReceipt, denialConfirmed } from '../src/followup.js';
const command =
  'git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -m direct-permission-followup';
const event = (cmd: string) => ({
  method: 'item/completed',
  params: {
    item: {
      id: 'item1',
      type: 'commandExecution',
      command: cmd,
      status: 'completed',
      exitCode: 128,
      aggregatedOutput: 'permission denied',
    },
  },
});
test('direct Git receipts require the prepared command rather than assistant claims or script wrappers', () => {
  assert.equal(directReceipt([event(command)])[0]?.exactDirectCommand, true);
  assert.equal(directReceipt([event(`/bin/zsh -lc '${command}'`)])[0]?.exactDirectCommand, true);
  assert.equal(
    directReceipt([event(`/bin/zsh -lc echo fake; '${command}'`)])[0]?.exactDirectCommand,
    false,
  );
  assert.equal(directReceipt([event('node permission-probe.mjs')])[0]?.exactDirectCommand, false);
  assert.deepEqual(
    directReceipt([
      { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Git denied' } } },
    ]),
    [],
  );
});
test('callback receipts correlate request, resolution, and terminal item', () => {
  const request = {
    id: 7,
    method: 'item/permissions/requestApproval',
    params: { itemId: 'p1', permissions: { fileSystem: { write: ['/fixture'] } } },
  };
  const done = { method: 'item/completed', params: { item: { id: 'p1', status: 'completed' } } };
  const resolved = { method: 'serverRequest/resolved', params: { requestId: 7 } };
  assert.equal(callbackReceipt([request, done, resolved])[0]?.correlatedCompletion, true);
  assert.equal(callbackReceipt([request, done, resolved])[0]?.resolved, true);
  assert.equal(
    callbackReceipt([request, { ...done, params: { item: { id: 'wrong' } } }, resolved])[0]
      ?.correlatedCompletion,
    false,
  );
  assert.equal(callbackReceipt([request, done])[0]?.resolved, false);
});

test('approval proof rejects a missing response, mismatched request or accepted terminal status', () => {
  const callback = {
    method: 'item/commandExecution/requestApproval',
    commandMatches: true,
    cwdMatches: true,
    correlatedCompletion: true,
    resolved: true,
    completionStatus: 'declined',
    requestDigest: 'request1',
    itemDigest: 'item1',
  };
  const records = [
    {
      type: 'native.approval-decision',
      details: { decision: 'decline', requestDigest: 'request1', itemDigest: 'item1' },
    },
  ];
  assert.equal(denialConfirmed(callback, records), true);
  assert.equal(denialConfirmed(callback, []), false);
  assert.equal(denialConfirmed({ ...callback, commandMatches: false }, records), false);
  assert.equal(denialConfirmed({ ...callback, cwdMatches: false }, records), false);
  assert.equal(denialConfirmed({ ...callback, requestDigest: 'other' }, records), false);
  assert.equal(denialConfirmed({ ...callback, completionStatus: 'completed' }, records), false);
  assert.equal(
    denialConfirmed({ ...callback, method: 'item/permissions/requestApproval' }, records),
    false,
  );
});

test('command approval receipts verify the exact target command and canonical cwd', () => {
  const cwd = process.cwd();
  const request = {
    id: 9,
    method: 'item/commandExecution/requestApproval',
    params: { itemId: 'p2', command, cwd },
  };
  assert.equal(callbackReceipt([request], { command, cwd })[0]?.commandMatches, true);
  assert.equal(callbackReceipt([request], { command, cwd })[0]?.cwdMatches, true);
  assert.equal(
    callbackReceipt([request], { command: 'different target', cwd })[0]?.commandMatches,
    false,
  );
  assert.equal(callbackReceipt([request], { command, cwd: '/' })[0]?.cwdMatches, false);
});
