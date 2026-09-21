import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from '../dist/index.js';
import { WorkspaceOwnership } from '../dist/workspace-ownership.js';

const info = {
  executable: '/fixture-codex',
  version: 'fixture-1',
  available: true,
  authenticated: true,
  cleanupVerified: true,
  executionModes: ['read-only', 'code'],
  models: [{ id: 'fixture-model', name: 'Fixture model', efforts: ['low'], defaultEffort: 'low' }],
};

function git(root, args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function readOnlyFixture(t, run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-runtime-read-ownership-')));
  const projectRoot = join(root, 'project'),
    dataRoot = join(root, 'data');
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, 'README.md'), '# Non-Git fixture\n');
  const calls = [];
  const adapter = {
    async discover() {
      return info;
    },
    async run(nativeInput) {
      calls.push(nativeInput);
      return run(nativeInput, calls.length);
    },
  };
  const runtime = new Runtime(adapter, dataRoot),
    project = runtime.addProject(projectRoot);
  const beforeClose = new Set();
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      for (const release of beforeClose) release();
      await runtime.close();
    }
  };
  t.after(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    projectRoot,
    dataRoot,
    runtime,
    project,
    calls,
    adapter,
    close,
    onClose: (release) => beforeClose.add(release),
  };
}

function fixture(t, run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-runtime-ownership-')));
  const projectRoot = join(root, 'project'),
    dataRoot = join(root, 'data');
  mkdirSync(projectRoot);
  git(projectRoot, ['init', '-b', 'main']);
  writeFileSync(join(projectRoot, 'file.txt'), 'seed\n');
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-m', 'seed']);
  const calls = [];
  const adapter = {
    async discover() {
      return info;
    },
    async run(input) {
      calls.push(input);
      return run(input, calls.length);
    },
  };
  const runtime = new Runtime(adapter, dataRoot),
    project = runtime.addProject(projectRoot),
    conversation = runtime.createConversation(project.id);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await runtime.close();
    }
  };
  t.after(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, projectRoot, dataRoot, runtime, project, conversation, calls, adapter, close };
}

async function settled(runtime) {
  for (let index = 0; index < 200 && runtime.hasActiveWork(); index += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.hasActiveWork(), false, 'runtime work did not settle');
}

async function waitFor(predicate, message) {
  for (let index = 0; index < 400; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function observe(promise, errors) {
  try {
    await promise;
  } catch (error) {
    errors.push(error);
  }
}

function input(conversationId) {
  return { conversationId, text: 'Inspect fixture.', model: 'fixture-model', effort: 'low' };
}

function completed(input, suffix = 'one') {
  input.onEvent({
    type: 'session.turn-started',
    summary: 'fixture native identity',
    data: { threadId: `fixture-thread-${suffix}`, turnId: `fixture-turn-${suffix}` },
  });
  return { status: 'completed' };
}

test('a parent workspace lease rejects send before worktree creation, run persistence, or native launch', async (t) => {
  const f = fixture(t, completed);
  const ownership = new WorkspaceOwnership(f.runtime.store);
  const held = ownership.acquire({
    reservationId: 'parent-owner',
    ownerId: 'parent-owner',
    workspace: f.projectRoot,
  });
  assert.equal(held.status, 'acquired');
  assert.equal(existsSync(join(f.projectRoot, '.worktrees')), false);
  await assert.rejects(
    f.runtime.send(input(f.conversation.id)),
    /workspace.*owned|unconfirmed cleanup|ownership/i,
  );
  assert.equal(existsSync(join(f.projectRoot, '.worktrees')), false);
  assert.equal(f.runtime.snapshot().runs.length, 0);
  assert.equal(f.calls.length, 0);
  ownership.release({
    reservationId: held.lease.reservationId,
    generation: held.lease.generation,
    cleanupConfirmed: true,
    cleanupEvidence: { fixture: 'released' },
  });
});

test('an ordinary run retains its real conversation workspace until a clean native result settles', async (t) => {
  const gate = deferred();
  const f = fixture(t, async (nativeInput) => {
    nativeInput.onEvent({
      type: 'session.turn-started',
      summary: 'fixture native identity',
      data: { threadId: 'fixture-thread', turnId: 'fixture-turn' },
    });
    return gate.promise;
  });
  const run = await f.runtime.send(input(f.conversation.id));
  assert.equal(f.calls.length, 1);
  assert.equal(existsSync(run.workspace), true);
  const ownership = new WorkspaceOwnership(f.runtime.store);
  assert.equal(
    ownership.acquire({
      reservationId: 'other-owner',
      ownerId: 'other-owner',
      workspace: run.workspace,
    }).status,
    'blocked',
  );
  gate.resolve({ status: 'completed' });
  await settled(f.runtime);
  const admitted = ownership.acquire({
    reservationId: 'other-owner',
    ownerId: 'other-owner',
    workspace: run.workspace,
  });
  assert.equal(admitted.status, 'acquired');
  ownership.release({
    reservationId: admitted.lease.reservationId,
    generation: admitted.lease.generation,
    cleanupConfirmed: true,
    cleanupEvidence: { fixture: 'released' },
  });
});

test('unknown native cleanup remains a durable workspace quarantine after reopen and blocks the original workspace alias', async (t) => {
  const f = fixture(t, async (nativeInput) => {
    nativeInput.onEvent({
      type: 'session.turn-started',
      summary: 'fixture native identity',
      data: { threadId: 'fixture-thread', turnId: 'fixture-turn' },
    });
    return { status: 'stop-unconfirmed' };
  });
  const run = await f.runtime.send(input(f.conversation.id));
  await settled(f.runtime);
  assert.equal(
    f.runtime.snapshot().runs.find((item) => item.id === run.id)?.cleanupUnconfirmed,
    true,
  );
  await f.close();
  const reopened = new Runtime(f.adapter, f.dataRoot);
  try {
    const ownership = new WorkspaceOwnership(reopened.store);
    const result = ownership.acquire({
      reservationId: 'other-conversation',
      ownerId: 'other-conversation',
      workspace: run.workspace,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason.kind, 'cleanup-unconfirmed');
    const alias = join(f.root, 'other-conversation-alias');
    symlinkSync(run.workspace, alias);
    assert.throws(
      () =>
        ownership.acquire({
          reservationId: 'other-conversation-alias',
          ownerId: 'other-conversation-alias',
          workspace: alias,
        }),
      /redirected|canonical/i,
    );
    assert.equal(
      reopened.snapshot().runs.find((item) => item.id === run.id)?.cleanupUnconfirmed,
      true,
    );
  } finally {
    await reopened.close();
  }
});

test('a checkpoint export ownership conflict fails before creating the destination directory', async (t) => {
  const f = fixture(t, completed);
  const run = await f.runtime.send(input(f.conversation.id));
  await settled(f.runtime);
  const checkpoint = f.runtime.snapshot().runs.find((item) => item.id === run.id)?.checkpoints?.[0];
  assert.ok(checkpoint);
  const destination = join(f.root, 'checkpoint-export');
  const ownership = new WorkspaceOwnership(f.runtime.store);
  const held = ownership.acquire({
    reservationId: 'export-owner',
    ownerId: 'export-owner',
    workspace: destination,
  });
  assert.equal(held.status, 'acquired');
  assert.equal(existsSync(destination), false);
  assert.throws(
    () => f.runtime.restoreCheckpoint({ runId: run.id, digest: checkpoint.digest }, destination),
    /workspace.*owned|unconfirmed cleanup|ownership/i,
  );
  assert.equal(existsSync(destination), false);
  ownership.release({
    reservationId: held.lease.reservationId,
    generation: held.lease.generation,
    cleanupConfirmed: true,
    cleanupEvidence: { fixture: 'released' },
  });
});

test('a queued native turn rechecks workspace ownership before dispatch', async (t) => {
  const gates = [],
    blockerCalls = [],
    blockerPromises = [],
    blockerErrors = [];
  const f = fixture(t, async (nativeInput) => {
    if (nativeInput.workspace.startsWith(join(f.root, 'blocker-'))) {
      const gate = deferred();
      gates.push(gate);
      blockerCalls.push(nativeInput);
      return gate.promise;
    }
    nativeInput.onEvent({
      type: 'session.turn-started',
      summary: 'fixture native identity',
      data: { threadId: 'main-thread', turnId: 'main-turn' },
    });
    return { status: 'completed' };
  });
  t.after(() => {
    for (const gate of gates) gate.resolve({ status: 'completed' });
  });
  let started = false;
  f.adapter.discover = async () => {
    if (!started) {
      started = true;
      for (let index = 0; index < 4; index += 1) {
        const admitted = f.runtime.nativeAdmission.adapter('codex', f.adapter, {
          owner: { kind: 'app-discovery', id: `blocker-${index}` },
        });
        blockerPromises.push(
          observe(
            admitted.run({
              workspace: join(f.root, `blocker-${index}`),
              executable: info.executable,
              executableVersion: info.version,
              model: 'fixture-model',
              effort: 'low',
              executionMode: 'read-only',
              messages: [],
              signal: new AbortController().signal,
              onEvent() {},
            }),
            blockerErrors,
          ),
        );
      }
      await waitFor(
        () => gates.length === 1,
        `a blocker turn was not admitted during discovery: ${blockerErrors.map((error) => error.message).join('; ')}`,
      );
    }
    return info;
  };
  const run = await f.runtime.send(input(f.conversation.id));
  await waitFor(
    () =>
      f.runtime.nativeAdmission.records
        .list({ runId: run.id })
        .some((operation) => operation.purpose === 'model-turn' && operation.state === 'queued'),
    'main turn was not queued',
  );
  const ownership = new WorkspaceOwnership(f.runtime.store);
  const lease = ownership.snapshot().find((item) => item.workspace === run.workspace);
  assert.ok(lease);
  ownership.release({
    reservationId: lease.reservationId,
    generation: lease.generation,
    cleanupConfirmed: false,
    cleanupEvidence: { fixture: 'quarantined before dispatch' },
  });
  for (let index = 0; index < 4; index += 1) {
    await waitFor(
      () => gates.length > index,
      `no native blocker remained before release ${index + 1}`,
    );
    gates[index].resolve({ status: 'completed' });
  }
  await Promise.all(blockerPromises);
  await settled(f.runtime);
  assert.equal(f.calls.filter((call) => call.workspace === run.workspace).length, 0);
  assert.equal(f.runtime.snapshot().runs.find((item) => item.id === run.id)?.status, 'failed');
});

test('a release persistence fault after clean adapter completion quarantines the original workspace without an unhandled background failure', async (t) => {
  const gate = deferred();
  const f = fixture(t, async (nativeInput) => {
    nativeInput.onEvent({
      type: 'session.turn-started',
      summary: 'fixture native identity',
      data: { threadId: 'fixture-thread', turnId: 'fixture-turn' },
    });
    return gate.promise;
  });
  const run = await f.runtime.send(input(f.conversation.id));
  await waitFor(() => f.calls.length === 1, 'adapter did not start');
  f.runtime.store.db.exec(
    "CREATE TRIGGER fail_workspace_release BEFORE UPDATE ON workspace_ownership WHEN json_extract(NEW.document, '$.state') = 'released' BEGIN SELECT RAISE(ABORT, 'workspace release write fault'); END",
  );
  gate.resolve({ status: 'completed' });
  await settled(f.runtime);
  const retained = f.runtime.snapshot().runs.find((item) => item.id === run.id);
  assert.equal(retained?.cleanupUnconfirmed, true);
  const ownership = new WorkspaceOwnership(f.runtime.store);
  assert.equal(
    ownership.acquire({
      reservationId: 'replacement-owner',
      ownerId: 'replacement-owner',
      workspace: run.workspace,
    }).status,
    'blocked',
  );
  f.runtime.store.db.exec('DROP TRIGGER fail_workspace_release');
});

test('non-Git read-only conversations share the root while each retained reader independently blocks writers', async (t) => {
  const gates = [];
  const f = readOnlyFixture(t, async (nativeInput) => {
    nativeInput.onEvent({
      type: 'session.turn-started',
      summary: 'fixture native identity',
      data: {
        threadId: `reader-thread-${gates.length + 1}`,
        turnId: `reader-turn-${gates.length + 1}`,
      },
    });
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });
  f.onClose(() => {
    for (const gate of gates) gate.resolve({ status: 'completed' });
  });
  const first = f.runtime.createConversation(f.project.id),
    second = f.runtime.createConversation(f.project.id);
  const runs = await Promise.allSettled([
    f.runtime.send(input(first.id)),
    f.runtime.send(input(second.id)),
  ]);
  if (runs.some((result) => result.status === 'rejected'))
    assert.fail(
      runs
        .filter((result) => result.status === 'rejected')
        .map((result) =>
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        )
        .join('; '),
    );
  const [firstRun, secondRun] = runs.map((result) => result.value);
  assert.equal(firstRun.workspace, f.projectRoot);
  assert.equal(secondRun.workspace, f.projectRoot);
  assert.equal(f.calls.length, 2);
  const ownership = new WorkspaceOwnership(f.runtime.store);
  assert.equal(
    ownership
      .snapshot()
      .filter((lease) => lease.workspace === f.projectRoot && lease.access === 'read').length,
    2,
  );
  assert.equal(
    ownership.acquire({
      reservationId: 'writer-before-readers-settle',
      ownerId: 'writer-before-readers-settle',
      workspace: f.projectRoot,
      access: 'write',
    }).status,
    'blocked',
  );
  gates[0].resolve({ status: 'completed' });
  await waitFor(
    () =>
      ownership
        .snapshot()
        .filter((lease) => lease.workspace === f.projectRoot && lease.access === 'read').length ===
      1,
    'first reader lease did not settle independently',
  );
  assert.equal(
    ownership.acquire({
      reservationId: 'writer-after-first-reader',
      ownerId: 'writer-after-first-reader',
      workspace: f.projectRoot,
      access: 'write',
    }).status,
    'blocked',
  );
  gates[1].resolve({ status: 'completed' });
  await settled(f.runtime);
  assert.equal(ownership.snapshot().filter((lease) => lease.workspace === f.projectRoot).length, 0);
  const saved = await f.runtime.saveProjectDefaults({
    projectId: f.project.id,
    defaults: { harness: 'codex', model: 'fixture-model', effort: 'low' },
    expectedRevision: null,
  });
  assert.ok(saved.revision);
});

test('non-Git read cleanup uncertainty blocks new readers and writers after reopen', async (t) => {
  const f = readOnlyFixture(t, async (nativeInput) => {
    nativeInput.onEvent({
      type: 'session.turn-started',
      summary: 'fixture native identity',
      data: { threadId: 'unknown-reader-thread', turnId: 'unknown-reader-turn' },
    });
    return { status: 'stop-unconfirmed' };
  });
  const original = f.runtime.createConversation(f.project.id);
  await f.runtime.send(input(original.id));
  await settled(f.runtime);
  assert.equal(f.calls.length, 1);
  await f.close();
  const reopened = new Runtime(f.adapter, f.dataRoot);
  try {
    const project = reopened.snapshot().projects.find((project) => project.id === f.project.id);
    assert.ok(project);
    const next = reopened.createConversation(project.id);
    await assert.rejects(
      reopened.send(input(next.id)),
      /workspace.*owned|unconfirmed cleanup|ownership/i,
    );
    await assert.rejects(
      reopened.saveProjectDefaults({
        projectId: project.id,
        defaults: { harness: 'codex', model: 'fixture-model', effort: 'low' },
        expectedRevision: null,
      }),
      /workspace.*owned|unconfirmed cleanup|ownership/i,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    await reopened.close();
  }
});

test('a read planning probe that times out quarantines its original root lease before workspace, run, or model effects', async (t) => {
  const f = readOnlyFixture(t, completed);
  const conversation = f.runtime.createConversation(f.project.id);
  const original = f.runtime.planWorkspace.bind(f.runtime);
  f.runtime.planWorkspace = (...args) => {
    original(...args);
    const error = new Error('fixture read planning timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  await assert.rejects(f.runtime.send(input(conversation.id)), /timeout/i);
  const retained = new WorkspaceOwnership(f.runtime.store)
    .snapshot()
    .filter((lease) => lease.workspace === f.projectRoot);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].access, 'read');
  assert.equal(retained[0].state, 'cleanup-unconfirmed');
  assert.equal(existsSync(join(f.projectRoot, '.worktrees')), false);
  assert.equal(f.runtime.snapshot().runs.length, 0);
  assert.equal(f.calls.length, 0);
});

test('failed reader-to-writer promotion preserves its original read lease until outer cleanup and makes no worktree or model', async (t) => {
  const f = fixture(t, completed);
  const conversation = f.conversation;
  const ownership = new WorkspaceOwnership(f.runtime.store);
  const other = ownership.acquire({
    reservationId: 'other-reader',
    ownerId: 'other-reader',
    workspace: f.projectRoot,
    access: 'read',
  });
  assert.equal(other.status, 'acquired');
  let duringFailure = [];
  const original = f.runtime.planWorkspace.bind(f.runtime);
  f.runtime.planWorkspace = (...args) => {
    try {
      return original(...args);
    } catch (error) {
      duringFailure = new WorkspaceOwnership(f.runtime.store)
        .snapshot()
        .filter((lease) => lease.workspace === f.projectRoot);
      throw error;
    }
  };
  await assert.rejects(
    f.runtime.send(input(conversation.id)),
    /waiting for other readers|workspace.*owned|ownership/i,
  );
  assert.equal(duringFailure.filter((lease) => lease.access === 'read').length, 2);
  const after = ownership.snapshot().filter((lease) => lease.workspace === f.projectRoot);
  assert.equal(after.length, 1);
  assert.equal(after[0].reservationId, other.lease.reservationId);
  assert.equal(existsSync(join(f.projectRoot, '.worktrees')), false);
  assert.equal(f.runtime.snapshot().runs.length, 0);
  assert.equal(f.calls.length, 0);
  ownership.release({
    reservationId: other.lease.reservationId,
    generation: other.lease.generation,
    cleanupConfirmed: true,
    cleanupEvidence: { fixture: 'reader released' },
  });
});
