import assert from 'node:assert/strict';
import test from 'node:test';
import { requireApproval, type Approval } from '../src/control.js';

const basis = { runId: 'fixture-run', revision: 1, parentOid: 'parent', contentDigest: 'content' };
const approval: Approval = { action: 'final', source: 'human', decision: 'approved', basis };

test('missing, denied, automated, or different-action approval cannot deliver', () => {
  assert.throws(() => requireApproval('final', basis));
  assert.throws(() => requireApproval('final', basis, { ...approval, decision: 'denied' }));
  assert.throws(() => requireApproval('final', basis, { ...approval, source: 'automatic' }));
  assert.throws(() => requireApproval('final', basis, { ...approval, action: 'intermediate' }));
  assert.throws(() => requireApproval('push', basis, approval));
  assert.doesNotThrow(() => requireApproval('final', basis, approval));
});

test('all review-basis changes invalidate approval', () => {
  for (const change of [{ runId: 'different' }, { revision: 2 }, { parentOid: 'new-parent' }, { contentDigest: 'new-content' }]) {
    assert.throws(() => requireApproval('final', { ...basis, ...change }, approval));
  }
});
