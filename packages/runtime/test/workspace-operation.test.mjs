import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { workspaceCleanupConfirmed } from '../dist/workspace-operation.js';
import { runSafeGit } from '../dist/git-review.js';
import { plannedConversationWorkspace } from '../dist/workspace.js';

test('synchronous subprocess cleanup preserves uncertainty through wrapped errors', () => {
  assert.equal(workspaceCleanupConfirmed(Object.assign(new Error('git exited'), { status: 1, signal: null, pid: 42 })), true);
  for (const details of [{ code: 'ETIMEDOUT' }, { code: 'ENOBUFS' }, { signal: 'SIGTERM' }, { status: null, pid: 42 }, { cleanupVerified: false }]) {
    const error = new Error('outer persistence boundary', { cause: new Error('operation wrapper', { cause: Object.assign(new Error('subprocess'), details) }) });
    assert.equal(workspaceCleanupConfirmed(error), false);
  }
  const cycle = new Error('cycle'); cycle.cause = cycle;
  assert.equal(workspaceCleanupConfirmed(cycle), false);
});

test('Git wrappers preserve timeout evidence and workspace discovery cannot reinterpret a timeout as a non-Git folder', () => {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw Object.assign(new Error('command timed out'), { code: 'ETIMEDOUT', status: null, pid: 42 }); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => runSafeGit('/fixture', ['status']), error => error.message.startsWith('Git operation failed:') && workspaceCleanupConfirmed(error) === false);
    assert.throws(() => plannedConversationWorkspace('/fixture', '00000000-0000-0000-0000-000000000001'), error => workspaceCleanupConfirmed(error) === false);
  } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
});
