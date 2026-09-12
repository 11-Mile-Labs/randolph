import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { Checkpoints } from '../dist/checkpoints.js';
import { prepareWorkspace } from '../dist/workspace.js';

function git(root, args) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'randolph-multi-harness-'));
  const projectRoot = join(root, 'project');
  const dataRoot = join(root, 'data');
  await mkdir(projectRoot);
  git(projectRoot, ['init', '-b', 'main']);
  await writeFile(join(projectRoot, 'README.md'), 'base\n');
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'base']);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { projectRoot, dataRoot };
}

async function settle(runtime) {
  for (let i = 0; i < 400 && runtime.hasActiveWork(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.hasActiveWork(), false);
}

function adapter(harness, { code = false, write = false, status = 'completed' } = {}) {
  const calls = [];
  const commands = [];
  return {
    calls,
    commands,
    async installations() { return [{ executable: `/${harness}` }]; },
    async discover(executable) {
      return {
        executable: executable ?? `/${harness}`,
        version: `${harness}-1.0.25`,
        available: true,
        authenticated: true,
        executionModes: code ? ['read-only', 'code'] : ['read-only'],
        models: [{ id: `${harness}-model`, name: harness, efforts: ['low'], defaultEffort: 'low' }],
      };
    },
    async run(input) {
      calls.push(input);
      if (write) await writeFile(join(input.workspace, 'README.md'), `${harness} changed\n`);
      return { status };
    },
    ...(code ? { async runCommand(input) { commands.push(input); return { exitCode: 0, output: 'passed', truncated: false, cleanupVerified: true }; } } : {}),
  };
}

test('routes concurrent conversations through their captured harness identities', async t => {
  const paths = await fixture(t);
  const codex = adapter('codex');
  const grok = adapter('grok');
  const runtime = new Runtime({ codex, grok }, paths.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(paths.projectRoot);
  await runtime.saveProjectDefaults({ projectId: project.id, defaults: { harness: 'grok', model: 'grok-model', effort: 'low', executable: '/grok' }, expectedRevision: null });
  const codexConversation = runtime.createConversation(project.id);
  const grokConversation = runtime.createConversation(project.id);
  await runtime.setConversationSelection({ conversationId: codexConversation.id, selection: { harness: 'codex', model: 'codex-model', effort: 'low' } });

  const [codexRun, grokRun] = await Promise.all([
    runtime.send({ conversationId: codexConversation.id, text: 'Codex request.' }),
    runtime.send({ conversationId: grokConversation.id, text: 'Grok request.' }),
  ]);
  await settle(runtime);

  assert.equal(codexRun.harness, 'codex');
  assert.equal(grokRun.harness, 'grok');
  assert.equal(codex.calls.length, 1);
  assert.equal(grok.calls.length, 1);
  assert.equal(codex.calls[0].model, 'codex-model');
  assert.equal(codex.calls[0].executable, '/codex');
  assert.equal(grok.calls[0].model, 'grok-model');
  assert.equal((await runtime.harnessInstallations('grok'))[0].harness, 'grok');
});

test('a project default change cannot redirect a frozen run or its checks', async t => {
  const paths = await fixture(t);
  await writeFile(join(paths.projectRoot, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.8.0', scripts: { test: 'echo ok' } }));
  git(paths.projectRoot, ['add', 'package.json']);
  git(paths.projectRoot, ['commit', '-m', 'checks']);
  const codex = adapter('codex', { code: true, write: true });
  const grok = adapter('grok', { code: true, write: true });
  const runtime = new Runtime({ codex, grok }, paths.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(paths.projectRoot);
  const first = await runtime.saveProjectDefaults({ projectId: project.id, defaults: { harness: 'codex', model: 'codex-model', effort: 'low', executable: '/codex' }, expectedRevision: null });
  const conversation = runtime.createConversation(project.id);
  await runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' });
  const run = await runtime.send({ conversationId: conversation.id, text: 'Change the project.' });
  await settle(runtime);
  await runtime.saveProjectDefaults({ projectId: project.id, defaults: { harness: 'grok', model: 'grok-model', effort: 'low', executable: '/grok' }, expectedRevision: first.revision });
  const review = runtime.prepareReview(conversation.id);
  await runtime.verifyReview(review.id);

  assert.equal(run.harness, 'codex');
  assert.ok(codex.commands.length > 0);
  assert.equal(grok.commands.length, 0);
  assert.ok(codex.commands.every(command => command.executable === '/codex' && command.executableVersion === 'codex-1.0.25'));
});

test('an unverified Grok code route rejects before native dispatch', async t => {
  const paths = await fixture(t);
  const grok = adapter('grok');
  const runtime = new Runtime({ grok }, paths.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(paths.projectRoot);
  await runtime.saveProjectDefaults({ projectId: project.id, defaults: { harness: 'grok', model: 'grok-model', effort: 'low', executable: '/grok' }, expectedRevision: null });
  const conversation = runtime.createConversation(project.id);

  await assert.rejects(runtime.setExecutionMode({ conversationId: conversation.id, executionMode: 'code' }), /Code mode is not verified/);
  assert.equal(grok.calls.length, 0);
  assert.equal(runtime.snapshot().runs.length, 0);
});

test('legacy Codex checkpoint recovery remains on Codex after project defaults change', async t => {
  const paths = await fixture(t);
  const codex = adapter('codex');
  const grok = adapter('grok');
  const runtime = new Runtime({ codex, grok }, paths.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(paths.projectRoot);
  const conversation = runtime.createConversation(project.id);
  const createdAt = new Date().toISOString();
  const run = {
    id: randomUUID(),
    projectId: project.id,
    conversationId: conversation.id,
    executable: '/codex',
    executableVersion: 'codex-1.0.25',
    status: 'interrupted',
    model: 'codex-model',
    effort: 'low',
    executionMode: 'read-only',
    workspace: prepareWorkspace(project.root, conversation.id),
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
  };
  runtime.store.putRun(run);
  runtime.store.putMessage({ id: randomUUID(), runId: run.id, conversationId: conversation.id, role: 'user', text: 'Resume this legacy run.', createdAt });
  runtime.store.exportRun(run);
  const checkpoint = new Checkpoints(runtime.store).capture(run, 'before-turn');
  await runtime.saveProjectDefaults({ projectId: project.id, defaults: { harness: 'grok', model: 'grok-model', effort: 'low', executable: '/grok' }, expectedRevision: null });

  const resumed = await runtime.restartRun({ runId: run.id, checkpointDigest: checkpoint.digest });
  await settle(runtime);

  assert.equal(resumed.run.harness, 'codex');
  assert.equal(codex.calls.length, 1);
  assert.equal(grok.calls.length, 0);
  assert.equal(codex.calls[0].executable, '/codex');
  assert.equal(codex.calls[0].executableVersion, 'codex-1.0.25');
});

test('withdrawing all execution capabilities blocks sends and retained checkpoint recovery', async t => {
  const paths = await fixture(t);
  const grok = adapter('grok');
  const discover = grok.discover;
  grok.discover = async executable => ({ ...await discover(executable), executionModes: [], reason: 'Native boundary failed.' });
  const runtime = new Runtime({ grok }, paths.dataRoot);
  t.after(() => runtime.close());
  const project = runtime.addProject(paths.projectRoot);
  await runtime.saveProjectDefaults({projectId:project.id,defaults:{harness:'grok',model:'grok-model',effort:'low',executable:'/grok'},expectedRevision:null});
  const conversation = runtime.createConversation(project.id);
  await assert.rejects(runtime.send({conversationId:conversation.id,text:'Do not dispatch'}), /Native boundary failed/);
  assert.equal(runtime.snapshot().runs.length,0);
  const createdAt = new Date().toISOString();
  const run = {id:randomUUID(),harness:'grok',projectId:project.id,conversationId:conversation.id,executable:'/grok',executableVersion:'grok-1.0.25',status:'interrupted',model:'grok-model',effort:'low',executionMode:'read-only',workspace:prepareWorkspace(project.root,conversation.id),createdAt,updatedAt:createdAt,lastActivityAt:createdAt};
  runtime.store.putRun(run);
  runtime.store.putMessage({id:randomUUID(),runId:run.id,conversationId:conversation.id,role:'user',text:'Retained task',createdAt});
  runtime.store.exportRun(run);
  const checkpoint = new Checkpoints(runtime.store).capture(run,'before-turn');
  await assert.rejects(runtime.restartRun({runId:run.id,checkpointDigest:checkpoint.digest}), /Native boundary failed/);
  await assert.rejects(runtime.rerunFromCheckpoint({runId:run.id,checkpointDigest:checkpoint.digest}), /Native boundary failed/);
  assert.equal(grok.calls.length,0);
  assert.equal(runtime.snapshot().runs.length,1);
});
