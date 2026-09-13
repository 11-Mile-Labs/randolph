import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/evidence.js';
import { captureCheckpoint } from '../src/checkpoint.js';
import { createFixture, removeFixture } from '../src/fixture.js';
import { hash } from '../src/codex.js';
import { appendRunEvent, requireRestartApproval, restartFromCheckpoint, type RestartApproval } from '../src/restart.js';
import { retainedRunState } from '../src/lifecycle.js';

const root = join(homedir(), '.cache', `randolph-restart-${randomUUID()}`);
mkdirSync(root, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

test('Restart requires an exact human decision, including conversation and checkpoint identity', () => {
  const current = { conversationId: 'conversation', previousRunId: 'old', checkpointDigest: 'digest' };
  const valid: RestartApproval = { ...current, action: 'restart', source: 'human', decision: 'approved' };
  assert.throws(() => requireRestartApproval(current));
  for (const changed of [{ source: 'automatic' }, { decision: 'denied' }, { action: 'resume' }, { previousRunId: 'other' }, { conversationId: 'other' }, { checkpointDigest: 'stale' }]) {
    assert.throws(() => requireRestartApproval(current, { ...valid, ...changed } as RestartApproval));
  }
  assert.doesNotThrow(() => requireRestartApproval(current, valid));
});

test('explicit Restart restores once into a linked run; read-only reopen and late events never dispatch', async () => {
  const fixture = await createFixture(join(root, 'source'), join(root, 'data'));
  const source = new Journal(join(root, 'history'));
  const next = new Journal(join(root, 'next'));
  const checkpointDir = join(root, 'checkpoint');
  const previousRunId = 'prior';
  const conversationId = 'same-conversation';
  source.append('lifecycle.state', 'Interrupted old work', { state: 'interrupted', runId: previousRunId });
  await captureCheckpoint({ worktree: fixture.worktree, checkpointDir, baseRef: 'HEAD', metadata: { runId: previousRunId, conversationId, decisions: ['retain'], pending: ['verify'] }, journal: source });
  await removeFixture(fixture);
  const previousHistory = readFileSync(source.path, 'utf8');
  const destination = join(root, 'restored');
  let calls = 0;
  const options = { checkpointDir, source, next, destination, previousRunId, conversationId,
    launch: async (restored: { worktree: string }) => { assert.ok(existsSync(join(restored.worktree, 'src/filter.mjs'))); calls++; } };
  await assert.rejects(() => restartFromCheckpoint(options), /human Restart/);
  assert.equal(calls, 0);
  assert.equal(existsSync(destination), false);
  const approval: RestartApproval = { action: 'restart', source: 'human', decision: 'approved', previousRunId, conversationId, checkpointDigest: hash(readFileSync(join(checkpointDir, 'manifest.json'), 'utf8')) };
  const runId = await restartFromCheckpoint({ ...options, approval });
  assert.notEqual(runId, previousRunId);
  assert.equal(calls, 1);
  const intent = next.records.find(event => event.type === 'restart.intent');
  assert.equal(intent?.details.previousRunId, previousRunId);
  assert.equal(intent?.details.conversationId, conversationId);
  assert.equal(intent?.details.unfinishedWorkAfterCheckpoint, 'lost');
  assert.equal(retainedRunState(new Journal(next.directory)), 'stopped');
  assert.equal(readFileSync(source.path, 'utf8'), previousHistory);
  assert.throws(() => appendRunEvent(next, runId, { runId: previousRunId, type: 'completion', details: {} }), /different run/);
  await assert.rejects(() => restartFromCheckpoint({ ...options, next: new Journal(next.directory), approval }), /already used/);
  assert.equal(calls, 1);
});
