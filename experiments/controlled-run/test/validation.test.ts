import assert from 'node:assert/strict';
import test from 'node:test';
import { realpathSync } from 'node:fs';
import { validateEffectivePolicy, baselineMatches } from '../src/validation.js';
const cwd = realpathSync.native(process.cwd());
const valid = () => ({ cwd, instructionSources: [], approvalPolicy: 'on-request', approvalsReviewer: 'user',
  activePermissionProfile: null, sandbox: { type: 'workspaceWrite', networkAccess: false,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true, writableRoots: [cwd] } });
test('effective policy rejects ambiguous roots, cwd, instructions, profiles and permissive settings', () => {
  assert.equal(validateEffectivePolicy(valid(), cwd).matches, true);
  for (const change of [
    { sandbox: { ...valid().sandbox, writableRoots: [] } },
    { sandbox: { ...valid().sandbox, writableRoots: [cwd, '/'] } },
    { sandbox: { ...valid().sandbox, networkAccess: true } },
    { sandbox: { ...valid().sandbox, excludeSlashTmp: false } },
    { cwd: '/' }, { cwd: undefined }, { instructionSources: ['unexpected.md'] },
    { instructionSources: undefined }, { approvalsReviewer: 'guardian' }, { activePermissionProfile: { id: 'unknown' } },
  ]) assert.equal(validateEffectivePolicy({ ...valid(), ...change }, cwd).matches, false);
});
test('fixture baseline requires the intended failing case and exact local refs', () => {
  const tests = { status: 1, emptyPassed: false, nonemptyPassed: true };
  const refs = { workHead: 'base', parentHead: 'base', remoteRefs: 'refs/heads/main:base' };
  assert.equal(baselineMatches(tests, refs, 'base'), true);
  for (const change of [{ status: null }, { status: 2 }, { emptyPassed: true }, { nonemptyPassed: false }]) {
    assert.equal(baselineMatches({ ...tests, ...change }, refs, 'base'), false);
  }
  assert.equal(baselineMatches(tests, { ...refs, parentHead: 'other' }, 'base'), false);
  assert.equal(baselineMatches(tests, { ...refs, remoteRefs: refs.remoteRefs + '\nrefs/heads/extra:base' }, 'base'), false);
});
