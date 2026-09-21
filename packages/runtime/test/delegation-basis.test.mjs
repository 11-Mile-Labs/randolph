import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { assertDelegationBasis, retainedDelegationBasis } from '../dist/delegation-basis.js';
import { Checkpoints } from '../dist/checkpoints.js';
import { Store } from '../dist/store.js';
import { prepareWorkspace } from '../dist/workspace.js';
import { workspaceIdentity } from '../dist/workspace-identity.js';

function git(root, ...args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}
function fixture(t, recoveryMessages) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-delegation-basis-'))),
    projectRoot = join(root, 'project'),
    data = join(root, 'data');
  mkdirSync(projectRoot);
  git(projectRoot, 'init', '-b', 'main');
  writeFileSync(join(projectRoot, 'tracked.txt'), 'tracked\n');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-m', 'seed');
  const store = new Store(data),
    project = {
      id: 'project-one',
      name: 'Fixture',
      root: projectRoot,
      createdAt: '2026-09-12T00:00:00.000Z',
    },
    conversation = {
      id: randomUUID(),
      projectId: project.id,
      title: 'Fixture',
      model: 'model',
      effort: 'low',
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
      lastReadSequence: 0,
    };
  store.putProject(project);
  store.putConversation(conversation);
  const workspace = prepareWorkspace(projectRoot, conversation.id),
    run = {
      id: 'run-one',
      projectId: project.id,
      conversationId: conversation.id,
      status: 'completed',
      model: 'model',
      effort: 'low',
      harness: 'grok',
      executable: '/opt/grok',
      executableVersion: '1',
      enabledHarnessRoutes: [{ harness: 'grok', executable: '/opt/grok' }],
      harnessAuthorizationRevision: 'a'.repeat(64),
      workspace,
      workspaceIdentity: workspaceIdentity(workspace),
      executionMode: 'code',
      projectContext: {
        revision: 'b'.repeat(64),
        value: { purpose: 'Fixture', instructions: 'Retain context.', documents: [] },
      },
      memory: { references: [], lessons: [] },
      ...(recoveryMessages ? { recoveryMessages } : {}),
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
      lastActivityAt: '2026-09-12T00:00:00.000Z',
    };
  store.putRun(run);
  mkdirSync(store.runDirectory(run), { recursive: true });
  const messages = [
    {
      id: 'user-one',
      conversationId: conversation.id,
      runId: run.id,
      role: 'user',
      text: 'Original request.',
      createdAt: run.createdAt,
    },
    {
      id: 'assistant-one',
      conversationId: conversation.id,
      runId: run.id,
      role: 'assistant',
      text: 'Current assistant result.',
      createdAt: run.createdAt,
    },
  ];
  for (const message of messages) store.putMessage(message);
  const checkpoint = new Checkpoints(store).capture(run, 'completed-turn'),
    retained = store.runs().find((item) => item.id === run.id),
    plan = { basis: retainedDelegationBasis(store, retained) };
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, projectRoot, store, workspace, run: retained, checkpoint, plan, messages };
}

test('a completed retained checkpoint and matching context pass without changing the parent ref or index', (t) => {
  const f = fixture(t),
    beforeHead = git(f.projectRoot, 'rev-parse', 'HEAD'),
    beforeIndex = git(f.projectRoot, 'status', '--porcelain=v1');
  assert.doesNotThrow(() => assertDelegationBasis(f.store, f.run, f.plan));
  assert.equal(git(f.projectRoot, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(f.projectRoot, 'status', '--porcelain=v1'), beforeIndex);
});

test('eligible untracked, deletion, binary, and mode edits invalidate the retained source tree', (t) => {
  for (const change of [
    (f) => writeFileSync(join(f.workspace, 'untracked.txt'), 'new\n'),
    (f) => unlinkSync(join(f.workspace, 'tracked.txt')),
    (f) => writeFileSync(join(f.workspace, 'binary.dat'), Buffer.from([0, 255, 10])),
    (f) => chmodSync(join(f.workspace, 'tracked.txt'), 0o755),
  ]) {
    const f = fixture(t);
    change(f);
    assert.throws(() => assertDelegationBasis(f.store, f.run, f.plan), /Source files changed/i);
  }
});

test('a changed message, selected model, or enabled route invalidates the retained context digest', (t) => {
  const message = fixture(t);
  message.store.putMessage({ ...message.messages[0], text: 'Changed request.' });
  assert.throws(
    () => assertDelegationBasis(message.store, message.run, message.plan),
    /source or context changed/i,
  );
  const model = fixture(t);
  assert.throws(
    () => assertDelegationBasis(model.store, { ...model.run, model: 'other-model' }, model.plan),
    /source or context changed/i,
  );
  const route = fixture(t);
  assert.throws(
    () =>
      assertDelegationBasis(
        route.store,
        { ...route.run, enabledHarnessRoutes: [{ harness: 'codex', executable: '/opt/codex' }] },
        route.plan,
      ),
    /source or context changed/i,
  );
});

test('recovery messages and the current assistant response are included in the retained context digest', (t) => {
  const f = fixture(t, [{ role: 'user', text: 'Recovered request.' }]),
    original = retainedDelegationBasis(f.store, f.run).contextDigest;
  f.store.putMessage({
    ...f.messages[0],
    text: 'Historical request changed but recovery governs context.',
  });
  assert.equal(retainedDelegationBasis(f.store, f.run).contextDigest, original);
  f.store.putMessage({ ...f.messages[1], text: 'Changed current assistant response.' });
  assert.notEqual(retainedDelegationBasis(f.store, f.run).contextDigest, original);
  assert.notEqual(
    retainedDelegationBasis(f.store, {
      ...f.run,
      recoveryMessages: [{ role: 'user', text: 'Different recovered request.' }],
    }).contextDigest,
    original,
  );
});

test('missing or corrupt checkpoint evidence and a replaced workspace fail closed', (t) => {
  const missing = fixture(t);
  rmSync(missing.checkpoint.directory, { recursive: true, force: true });
  assert.throws(
    () => retainedDelegationBasis(missing.store, missing.run),
    /Checkpoint|checkpoint/i,
  );
  const corrupt = fixture(t);
  writeFileSync(join(corrupt.checkpoint.directory, 'manifest.json'), '{not-json');
  assert.throws(
    () => retainedDelegationBasis(corrupt.store, corrupt.run),
    /Checkpoint|checkpoint|JSON/i,
  );
  const replaced = fixture(t);
  rmSync(replaced.workspace, { recursive: true, force: true });
  mkdirSync(replaced.workspace);
  assert.throws(
    () => assertDelegationBasis(replaced.store, replaced.run, replaced.plan),
    /workspace directory changed|workspace/i,
  );
});
