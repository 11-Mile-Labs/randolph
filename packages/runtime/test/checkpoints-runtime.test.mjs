import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { prepareWorkspace } from '../dist/workspace.js';

const info = { executable: '/fixture-codex', available: true, authenticated: true, version: 'fixture', executionModes: ['read-only', 'code'], models: [{ id: 'fixture', name: 'Fixture', efforts: ['low'], defaultEffort: 'low' }] };
function git(root, ...args) { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8' }).trim(); }
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-checkpoints-'))), projectRoot = join(root, 'project'), data = join(root, 'data');
  mkdirSync(projectRoot); git(projectRoot, 'init', '-b', 'main'); writeFileSync(join(projectRoot, 'file.txt'), 'before\n'); git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-m', 'seed');
  t.after(() => rmSync(root, { recursive: true, force: true })); return { root, projectRoot, data };
}
async function settle(runtime) { for (let i = 0; i < 500 && runtime.hasActiveWork(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(runtime.hasActiveWork(), false); }

test('automatic checkpoints retain both boundaries, survive source deletion, and restore without executing or changing history', async t => {
  const paths = fixture(t); let calls = 0;
  const adapter = { discover: async () => info, run: async input => { calls++; input.onEvent({ type: 'session.turn-started', summary: 'fixture turn established', data: { threadId: 'checkpoint-thread', turnId: `checkpoint-turn-${calls}` } }); writeFileSync(join(input.workspace, 'file.txt'), 'completed\n'); writeFileSync(join(input.workspace, 'binary.dat'), Buffer.from([0, 255, 10])); input.onEvent({ type: 'message.delta', summary: 'reply', data: { messageId: 'reply', text: 'Completed the fixture.' } }); return { status: 'completed' }; } };
  const runtime = new Runtime(adapter, paths.data), project = runtime.addProject(paths.projectRoot), conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const started = await runtime.send({ conversationId: conversation.id, text: 'Complete the fixture.' }); await settle(runtime);
  const run = runtime.snapshot().runs.find(item => item.id === started.id); assert.deepEqual(run.checkpoints.map(item => item.boundary), ['before-turn', 'completed-turn']);
  assert.equal(git(paths.projectRoot, 'status', '--porcelain', '--', 'file.txt'), '');
  const before = JSON.stringify(runtime.store.snapshot()); await runtime.close(); rmSync(paths.projectRoot, { recursive: true });
  const reopened = new Runtime(adapter, paths.data); t.after(() => reopened.close());
  assert.equal(JSON.stringify(reopened.store.snapshot()), before); assert.equal(calls, 1);
  const initial = reopened.restoreCheckpoint({ runId: run.id, digest: run.checkpoints[0].digest }, join(paths.root, 'initial'));
  assert.equal(readFileSync(join(initial.workspace, 'file.txt'), 'utf8'), 'before\n');
  const result = reopened.restoreCheckpoint({ runId: run.id, digest: run.checkpoints[1].digest }, join(paths.root, 'restored'));
  assert.equal(readFileSync(join(result.workspace, 'file.txt'), 'utf8'), 'completed\n');
  assert.deepEqual(readFileSync(join(result.workspace, 'binary.dat')), Buffer.from([0, 255, 10]));
  assert.equal(JSON.stringify(reopened.store.snapshot()), before); assert.equal(calls, 1);
  assert.throws(() => reopened.restoreCheckpoint({ runId: run.id, digest: '0'.repeat(64) }, join(paths.root, 'wrong')), /selected recoverable checkpoint/);
});

test('an unsupported starting snapshot blocks native dispatch and retains a visible failure', async t => {
  const paths = fixture(t); let calls = 0;
  const runtime = new Runtime({ discover: async () => info, run: async input => { calls++; input.onEvent({ type: 'session.turn-started', summary: 'fixture turn established', data: { threadId: 'empty-folder-thread', turnId: `empty-folder-turn-${calls}` } }); return { status: 'completed' }; } }, paths.data); t.after(() => runtime.close());
  const project = runtime.addProject(paths.projectRoot), conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const workspace = prepareWorkspace(project.root, conversation.id);
  rmSync(join(workspace, 'file.txt'));
  execFileSync('/usr/bin/mkfifo', [join(workspace, 'file.txt')]);
  await assert.rejects(runtime.send({ conversationId: conversation.id, text: 'Do not launch on an incomplete checkpoint.' }));
  assert.equal(calls, 0); const run = runtime.snapshot().runs.at(-1); assert.equal(run.status, 'failed'); assert.match(run.error, /No harness was launched/); assert.ok(run.checkpointError); assert.equal(run.checkpoints?.length ?? 0, 0);
});


test('root folders show unsupported file recovery while Code mode refuses dispatch', async t => {
  const paths = fixture(t), empty = join(paths.root, 'empty'); mkdirSync(empty); git(empty, 'init', '-b', 'main'); let calls = 0;
  const runtime = new Runtime({ discover: async () => info, run: async input => { calls++; input.onEvent({ type: 'session.turn-started', summary: 'fixture turn established', data: { threadId: 'empty-folder-thread', turnId: `empty-folder-turn-${calls}` } }); return { status: 'completed' }; } }, paths.data); t.after(() => runtime.close());
  const project = runtime.addProject(empty), conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  await assert.rejects(runtime.send({ conversationId: conversation.id, text: 'No initial commit yet.' })); assert.equal(calls, 0);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'read-only' });
  await runtime.send({ conversationId: conversation.id, text: 'Inspect the empty folder.' }); await settle(runtime);
  const run = runtime.snapshot().runs.at(-1); assert.equal(calls, 1); assert.equal(run.status, 'completed'); assert.match(run.checkpointError, /no recoverable code checkpoint/); assert.equal(run.checkpoints?.length ?? 0, 0);
});
