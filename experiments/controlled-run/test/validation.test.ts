import assert from 'node:assert/strict';
import test from 'node:test';
import { realpathSync } from 'node:fs';
import { validateEffectivePolicy, baselineMatches } from '../src/validation.js';
const cwd = realpathSync.native(process.cwd());
const valid = () => ({ cwd, runtimeWorkspaceRoots: [cwd], instructionSources: [], approvalPolicy: 'on-request', approvalsReviewer: 'user',
  activePermissionProfile: null, sandbox: { type: 'workspaceWrite', networkAccess: false,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true, writableRoots: [cwd] } });
test('effective policy rejects ambiguous roots, cwd, instructions, profiles and permissive settings', () => {
  assert.equal(validateEffectivePolicy(valid(), cwd).matches, true);
  for (const change of [
    { sandbox: { ...valid().sandbox, writableRoots: [] } },
    { sandbox: { ...valid().sandbox, writableRoots: [cwd, '/'] } },
    { sandbox: { ...valid().sandbox, networkAccess: true } },
    { sandbox: { ...valid().sandbox, excludeSlashTmp: false } },
    { runtimeWorkspaceRoots: [] }, { runtimeWorkspaceRoots: [cwd, '/'] }, { cwd: '/' }, { cwd: undefined }, { instructionSources: ['unexpected.md'] },
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

test('version-pinned project roots admit empty additional roots without admitting an extra workspace', () => {
  const thread = { ...valid(), sandbox: { ...valid().sandbox, writableRoots: [] } };
  assert.equal(validateEffectivePolicy(thread, cwd, 'codex-cli 0.149.0').matches, true);
  assert.equal(validateEffectivePolicy(thread, cwd, 'codex-cli unknown').matches, false);
  assert.equal(validateEffectivePolicy({ ...thread, runtimeWorkspaceRoots: ['/'] }, cwd, 'codex-cli 0.149.0').matches, false);
});

test('known global instructions require matching source identity and immutable contents', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { hash } = await import('../src/codex.js');
  const dir = mkdtempSync(join(tmpdir(), 'randolph-instructions-'));
  try {
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, 'Synthetic instructions');
    const inventory = [{ path, digest: hash('Synthetic instructions') }];
    const thread = { ...valid(), instructionSources: [path] };
    assert.equal(validateEffectivePolicy(thread, cwd, 'codex-cli 0.149.0', inventory).matches, true);
    assert.equal(validateEffectivePolicy({ ...thread, instructionSources: [path, '/unknown'] }, cwd, 'codex-cli 0.149.0', inventory).matches, false);
    writeFileSync(path, 'Changed');
    assert.equal(validateEffectivePolicy(thread, cwd, 'codex-cli 0.149.0', inventory).matches, false);
  } finally { rmSync(dir, { recursive: true }); }
});
