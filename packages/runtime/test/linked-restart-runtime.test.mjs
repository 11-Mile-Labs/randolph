import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { AdapterRunFailure } from '../dist/contracts.js';

const info = {
  executable: '/fixture-codex',
  available: true,
  authenticated: true,
  version: 'fixture-1',
  executionModes: ['read-only', 'code'],
  models: [
    { id: 'model-a', name: 'Model A', efforts: ['low'], defaultEffort: 'low' },
    { id: 'model-b', name: 'Model B', efforts: ['high'], defaultEffort: 'high' },
  ],
};

function git(directory, args) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function fixture(t, statuses) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-linked-runtime-')));
  const projectRoot = join(root, 'project');
  const dataRoot = join(root, 'data');
  mkdirSync(projectRoot);
  git(projectRoot, ['init', '-b', 'main']);
  writeFileSync(join(projectRoot, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(projectRoot, 'value.txt'), 'base\n');
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'base']);
  const calls = [];
  const adapter = {
    installations: async () => [{ executable: '/fixture-codex', version: 'fixture-1' }],
    discover: async () => info,
    run: async input => {
      calls.push({ ...input, messages: structuredClone(input.messages) });
      input.onEvent({ type: 'session.turn-started', summary: 'fixture turn established', data: { threadId: 'linked-thread', turnId: `linked-turn-${calls.length}` } });
      writeFileSync(join(input.workspace, 'value.txt'), `run-${calls.length}\n`);
      if (calls.length === 1) input.onEvent({ type: 'message.delta', summary: 'partial', data: { messageId: 'partial', text: 'partial output' } });
      const result = statuses[calls.length - 1] ?? 'completed';
      if (result instanceof Error) throw result;
      return { status: result };
    },
  };
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { adapter, calls, dataRoot, projectRoot, root };
}

async function settle(runtime) {
  for (let count = 0; count < 500 && runtime.hasActiveWork(); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.hasActiveWork(), false);
}

test('explicit restart creates a linked run in the same conversation from its last safe starting checkpoint', async t => {
  const f = fixture(t, ['interrupted', 'completed', 'completed', 'completed']);
  let runtime = new Runtime(f.adapter, f.dataRoot);
  runtime.memory.prepare = () => ({ references: [], text: 'Saved memory context.', estimatedTokens: 5, frameworks: {} });
  const project = runtime.addProject(f.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const original = await runtime.send({ conversationId: conversation.id, text: 'Do the interrupted work.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  const source = runtime.snapshot().runs.find(run => run.id === original.id);
  assert.equal(source.status, 'interrupted');
  assert.deepEqual(source.checkpoints.map(checkpoint => checkpoint.boundary), ['before-turn']);
  await runtime.setConversationSelection({ conversationId: conversation.id, selection: { harness: 'codex', model: 'model-b', effort: 'high' } });
  await runtime.close();

  runtime = new Runtime(f.adapter, f.dataRoot);
  runtime.memory.prepare = () => ({ references: [], text: 'Saved memory context.', estimatedTokens: 5, frameworks: {} });
  t.after(() => runtime.close());
  assert.equal(f.calls.length, 1);
  const result = await runtime.restartRun({ runId: source.id, checkpointDigest: source.checkpoints[0].digest });
  assert.equal(result.conversation.id, conversation.id);
  assert.equal(result.run.sourceRunId, source.id);
  assert.equal(result.run.sourceCheckpointDigest, source.checkpoints[0].digest);
  assert.equal(result.run.recoveryKind, 'restart');
  assert.notEqual(result.run.workspace, source.workspace);
  await settle(runtime);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].model, 'model-a');
  assert.equal(f.calls[1].effort, 'low');
  assert.deepEqual(f.calls[1].messages, [
    { role: 'user', text: 'Saved memory context.' },
    { role: 'user', text: 'Do the interrupted work.' },
  ]);
  assert.equal(readFileSync(join(f.calls[1].workspace, 'value.txt'), 'utf8'), 'run-2\n');
  await assert.rejects(runtime.restartRun({ runId: source.id, checkpointDigest: source.checkpoints[0].digest }), /newer run|latest run/i);
  const restarted = runtime.snapshot().runs.find(run => run.id === result.run.id);
  const restartedCheckpoint = restarted.checkpoints.findLast(checkpoint => checkpoint.boundary === 'completed-turn');

  await runtime.send({ conversationId: conversation.id, text: 'Continue from the clean recovery.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  assert.deepEqual(f.calls[2].messages, [
    { role: 'user', text: 'Saved memory context.' },
    { role: 'user', text: 'Do the interrupted work.' },
    { role: 'user', text: 'Continue from the clean recovery.' },
  ]);
  assert.equal(runtime.snapshot().messages.some(message => message.text === 'partial output'), true);

  const rerun = await runtime.rerunFromCheckpoint({ runId: restarted.id, checkpointDigest: restartedCheckpoint.digest });
  await settle(runtime);
  assert.deepEqual(f.calls[3].messages, [
    { role: 'user', text: 'Saved memory context.' },
    { role: 'user', text: 'Do the interrupted work.' },
  ]);
  assert.deepEqual(rerun.run.recoveryMessages, [{ role: 'user', text: 'Do the interrupted work.' }]);
  assert.equal(f.calls.length, 4);
});

test('explicit rerun of an earlier result creates a linked conversation with saved context and fresh review state', async t => {
  const f = fixture(t, ['completed', 'completed', 'completed']);
  const runtime = new Runtime(f.adapter, f.dataRoot);
  t.after(() => runtime.close());
  runtime.memory.prepare = () => ({ references: [], text: 'Saved memory context.', estimatedTokens: 5, frameworks: {} });
  const project = runtime.addProject(f.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const first = await runtime.send({ conversationId: conversation.id, text: 'First retained request.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  const firstRun = runtime.snapshot().runs.find(run => run.id === first.id);
  const firstCheckpoint = firstRun.checkpoints.findLast(checkpoint => checkpoint.boundary === 'completed-turn');
  await runtime.send({ conversationId: conversation.id, text: 'Later request.', model: 'model-b', effort: 'high' });
  await settle(runtime);

  const result = await runtime.rerunFromCheckpoint({ runId: firstRun.id, checkpointDigest: firstCheckpoint.digest });
  assert.notEqual(result.conversation.id, conversation.id);
  assert.equal(result.conversation.sourceConversationId, conversation.id);
  assert.equal(result.conversation.title, 'Rerun: First retained request.');
  assert.equal(result.run.conversationId, result.conversation.id);
  assert.equal(result.run.sourceRunId, firstRun.id);
  assert.equal(result.run.recoveryKind, 'rerun');
  await settle(runtime);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].model, 'model-a');
  assert.equal(f.calls[2].effort, 'low');
  assert.deepEqual(f.calls[2].messages, [
    { role: 'user', text: 'Saved memory context.' },
    { role: 'user', text: 'First retained request.' },
  ]);
  assert.deepEqual(result.run.recoveryMessages, [{ role: 'user', text: 'First retained request.' }]);
  assert.equal(runtime.snapshot().reviews.some(review => review.conversationId === result.conversation.id), false);
  const review = runtime.prepareReview(result.conversation.id);
  assert.equal(review.conversationId, result.conversation.id);
  assert.equal(review.runId, result.run.id);
  assert.equal(review.deliveryPlan, undefined);
  assert.equal(review.verification, undefined);
});

test('explicit rerun accepts a failed run before-turn checkpoint', async t => {
  const f = fixture(t, [new AdapterRunFailure('fixture failure', { processTermination: 'confirmed' }), 'completed']);
  const runtime = new Runtime(f.adapter, f.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(f.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const original = await runtime.send({ conversationId: conversation.id, text: 'Retry failed work.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  const source = runtime.snapshot().runs.find(run => run.id === original.id);
  assert.equal(source.status, 'failed');
  assert.deepEqual(source.checkpoints.map(checkpoint => checkpoint.boundary), ['before-turn']);
  const result = await runtime.rerunFromCheckpoint({ runId: source.id, checkpointDigest: source.checkpoints[0].digest });
  assert.notEqual(result.conversation.id, conversation.id);
  await settle(runtime);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].messages, [{ role: 'user', text: 'Retry failed work.' }]);
});

test('linked execution preserves a saved read-only mode and does not require code capability', async t => {
  const f = fixture(t, ['completed', 'completed', 'completed']);
  const runtime = new Runtime(f.adapter, f.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(f.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  await runtime.send({ conversationId: conversation.id, text: 'Create a managed worktree.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'read-only' });
  const original = await runtime.send({ conversationId: conversation.id, text: 'Read the retained tree.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  const source = runtime.snapshot().runs.find(run => run.id === original.id);
  const checkpoint = source.checkpoints.findLast(item => item.boundary === 'completed-turn');
  f.adapter.discover = async () => ({ ...info, executionModes: ['read-only'] });
  const result = await runtime.rerunFromCheckpoint({ runId: source.id, checkpointDigest: checkpoint.digest });
  assert.equal(result.run.executionMode, 'read-only');
  await settle(runtime);
  assert.equal(f.calls[2].executionMode, 'read-only');
});

test('cleanup quarantine blocks restart without dispatch', async t => {
  const f = fixture(t, ['interrupted']);
  const runtime = new Runtime(f.adapter, f.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(f.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const original = await runtime.send({ conversationId: conversation.id, text: 'Quarantined request.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  const source = runtime.snapshot().runs.find(run => run.id === original.id);
  source.cleanupUnconfirmed = true;
  runtime.store.putRun(source);
  const input = { runId: source.id, checkpointDigest: source.checkpoints[0].digest };
  await assert.rejects(runtime.restartRun(input), /cleanup|reconcil/i);
  assert.equal(f.calls.length, 1);
});

test('cleanup quarantine blocks rerun without dispatch', async t => {
  const f = fixture(t, ['completed']);
  const runtime = new Runtime(f.adapter, f.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(f.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const original = await runtime.send({ conversationId: conversation.id, text: 'Quarantined request.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  const source = runtime.snapshot().runs.find(run => run.id === original.id);
  source.cleanupUnconfirmed = true;
  runtime.store.putRun(source);
  const checkpoint = source.checkpoints.findLast(item => item.boundary === 'completed-turn');
  await assert.rejects(runtime.rerunFromCheckpoint({ runId: source.id, checkpointDigest: checkpoint.digest }), /cleanup|reconcil/i);
  assert.equal(f.calls.length, 1);
});

test('a failed pre-dispatch restart remains in history and the original safe checkpoint can be retried', async t => {
  const f = fixture(t, ['interrupted', 'completed']);
  const runtime = new Runtime(f.adapter, f.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(f.projectRoot);
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const original = await runtime.send({ conversationId: conversation.id, text: 'Recover after a local restore failure.', model: 'model-a', effort: 'low' });
  await settle(runtime);
  const source = runtime.snapshot().runs.find(run => run.id === original.id);
  const input = { runId: source.id, checkpointDigest: source.checkpoints[0].digest };
  const restore = runtime.checkpoints.restoreWorktree.bind(runtime.checkpoints);
  runtime.checkpoints.restoreWorktree = () => { throw new Error('fixture restore failure'); };
  await assert.rejects(runtime.restartRun(input), /fixture restore failure/);
  const failedAttempt = runtime.snapshot().runs.at(-1);
  assert.equal(failedAttempt.sourceRunId, source.id);
  assert.equal(failedAttempt.status, 'failed');
  assert.match(failedAttempt.error, /No harness was launched/);
  assert.equal(f.calls.length, 1);

  runtime.checkpoints.restoreWorktree = restore;
  const retried = await runtime.restartRun(input);
  assert.equal(retried.run.sourceRunId, source.id);
  await settle(runtime);
  assert.equal(f.calls.length, 2);
  assert.equal(runtime.snapshot().runs.some(run => run.id === failedAttempt.id && run.status === 'failed'), true);
});
