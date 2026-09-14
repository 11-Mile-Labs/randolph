import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCheckpoint, restoreCheckpoint } from '../dist/checkpoint-storage.js';
import { DelegationIntegration } from '../dist/delegation-integration.js';
import { prepareWorkspace } from '../dist/workspace.js';
import { workspaceIdentity } from '../dist/workspace-identity.js';

function git(root, ...args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'init.templateDir=',
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
function descriptor(manifest) {
  return {
    checkpointDirectory: manifest.directory,
    checkpointDigest: manifest.digest,
    treeOid: manifest.snapshotTreeOid,
  };
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-delegation-integration-'))),
    project = join(root, 'project'),
    evidence = join(root, 'evidence');
  mkdirSync(project);
  mkdirSync(evidence);
  git(project, 'init', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'base a\n');
  writeFileSync(join(project, 'b.txt'), 'base b\n');
  writeFileSync(join(project, 'remove.txt'), 'remove me\n');
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'seed');
  const workspace = prepareWorkspace(project, '11111111-1111-4111-8111-111111111111'),
    target = createCheckpoint(workspace, evidence, { fixture: 'target' });
  const outputs = [];
  for (const [name, file, text] of [
    ['one', 'a.txt', 'writer one\n'],
    ['two', 'b.txt', 'writer two\n'],
  ]) {
    const destination = join(root, name);
    restoreCheckpoint(target.directory, target.digest, destination);
    writeFileSync(join(destination, file), text);
    outputs.push(createCheckpoint(destination, evidence, { fixture: name }));
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { workspace, evidence, target, outputs };
}

test('builds and applies a retained multi-writer candidate without changing Git refs or index', (t) => {
  const f = fixture(t),
    integration = new DelegationIntegration(),
    beforeHead = git(f.workspace, 'rev-parse', 'HEAD'),
    beforeIndex = git(f.workspace, 'status', '--porcelain=v1');
  const plan = integration.prepare({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    evidenceDirectory: f.evidence,
    target: descriptor(f.target),
    inputs: [
      {
        assignmentId: 'writer-one',
        source: descriptor(f.target),
        output: descriptor(f.outputs[0]),
      },
      {
        assignmentId: 'writer-two',
        source: descriptor(f.target),
        output: descriptor(f.outputs[1]),
      },
    ],
  });
  assert.deepEqual(plan.conflicts, []);
  integration.apply({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    plan,
  });
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'writer one\n');
  assert.equal(readFileSync(join(f.workspace, 'b.txt'), 'utf8'), 'writer two\n');
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), beforeHead);
  assert.notEqual(git(f.workspace, 'status', '--porcelain=v1'), beforeIndex);
});

test('rejects applying a conflicted or stale candidate without touching the target workspace', (t) => {
  const f = fixture(t),
    integration = new DelegationIntegration();
  const plan = integration.prepare({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    evidenceDirectory: f.evidence,
    target: descriptor(f.target),
    inputs: [
      {
        assignmentId: 'writer-one',
        source: descriptor(f.target),
        output: descriptor(f.outputs[0]),
      },
    ],
  });
  writeFileSync(join(f.workspace, 'a.txt'), 'external\n');
  assert.throws(
    () =>
      integration.apply({
        workspace: f.workspace,
        workspaceIdentity: workspaceIdentity(f.workspace),
        plan,
      }),
    /changed after candidate/i,
  );
});

test('retains a visible conflict and never applies its conflict tree', (t) => {
  const f = fixture(t);
  const left = join(dirname(f.workspace), 'left');
  const right = join(dirname(f.workspace), 'right');
  restoreCheckpoint(f.target.directory, f.target.digest, left);
  restoreCheckpoint(f.target.directory, f.target.digest, right);
  writeFileSync(join(left, 'a.txt'), 'left writer\n');
  writeFileSync(join(right, 'a.txt'), 'right writer\n');
  const leftOutput = createCheckpoint(left, f.evidence, { fixture: 'left' });
  const rightOutput = createCheckpoint(right, f.evidence, { fixture: 'right' });
  const integration = new DelegationIntegration();
  const plan = integration.prepare({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    evidenceDirectory: f.evidence,
    target: descriptor(f.target),
    inputs: [
      { assignmentId: 'writer-left', source: descriptor(f.target), output: descriptor(leftOutput) },
      {
        assignmentId: 'writer-right',
        source: descriptor(f.target),
        output: descriptor(rightOutput),
      },
      {
        assignmentId: 'writer-later',
        source: descriptor(f.target),
        output: descriptor(f.outputs[1]),
      },
    ],
  });
  assert.deepEqual(plan.conflicts, ['writer-right:a.txt']);
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.processedInputs, ['writer-left', 'writer-right']);
  assert.deepEqual(plan.pendingInputs, ['writer-later']);
  assert.throws(
    () =>
      integration.apply({
        workspace: f.workspace,
        workspaceIdentity: workspaceIdentity(f.workspace),
        plan,
      }),
    /unresolved conflicts/i,
  );
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'base a\n');
});

test('preserves a chained writer delta and binary, mode, deletion, and untracked entries', (t) => {
  const f = fixture(t);
  const first = join(dirname(f.workspace), 'first');
  restoreCheckpoint(f.target.directory, f.target.digest, first);
  writeFileSync(join(first, 'a.txt'), 'writer one\n');
  const firstOutput = createCheckpoint(first, f.evidence, { fixture: 'first' });
  const second = join(dirname(f.workspace), 'second');
  restoreCheckpoint(firstOutput.directory, firstOutput.digest, second);
  writeFileSync(join(second, 'b.txt'), 'writer two\n');
  writeFileSync(join(second, 'binary.bin'), Buffer.from([0, 255, 0, 4]));
  writeFileSync(join(second, 'tool.sh'), '#!/bin/sh\necho trail\n');
  chmodSync(join(second, 'tool.sh'), 0o755);
  symlinkSync('tool.sh', join(second, 'tool-link'));
  unlinkSync(join(second, 'remove.txt'));
  const secondOutput = createCheckpoint(second, f.evidence, { fixture: 'second' });
  const integration = new DelegationIntegration();
  const plan = integration.prepare({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    evidenceDirectory: f.evidence,
    workspaceBefore: descriptor(f.target),
    target: descriptor(firstOutput),
    inputs: [
      {
        assignmentId: 'writer-two',
        source: descriptor(firstOutput),
        output: descriptor(secondOutput),
      },
    ],
  });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.workspaceBefore.treeOid, f.target.snapshotTreeOid);
  assert.equal(plan.target.treeOid, firstOutput.snapshotTreeOid);
  integration.apply({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    plan,
  });
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'writer one\n');
  assert.equal(readFileSync(join(f.workspace, 'b.txt'), 'utf8'), 'writer two\n');
  assert.deepEqual(readFileSync(join(f.workspace, 'binary.bin')), Buffer.from([0, 255, 0, 4]));
  assert.equal(lstatSync(join(f.workspace, 'tool.sh')).mode & 0o111, 0o111);
  assert.equal(lstatSync(join(f.workspace, 'tool-link')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(f.workspace, 'tool-link'), 'utf8'), '#!/bin/sh\necho trail\n');
  assert.throws(() => lstatSync(join(f.workspace, 'remove.txt')), /ENOENT/);
});

test('refuses an ignored parent symlink before it can touch an outside destination', (t) => {
  const f = fixture(t);
  const writer = join(dirname(f.workspace), 'ignored-writer');
  restoreCheckpoint(f.target.directory, f.target.digest, writer);
  mkdirSync(join(writer, 'ignoredDir'));
  writeFileSync(join(writer, 'ignoredDir', 'sentinel.txt'), 'candidate\n');
  const output = createCheckpoint(writer, f.evidence, { fixture: 'ignored-writer' });
  const plan = new DelegationIntegration().prepare({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    evidenceDirectory: f.evidence,
    target: descriptor(f.target),
    inputs: [
      { assignmentId: 'writer-ignored', source: descriptor(f.target), output: descriptor(output) },
    ],
  });
  const outside = join(dirname(f.workspace), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.txt'), 'outside remains\n');
  symlinkSync(outside, join(f.workspace, 'ignoredDir'));
  const exclude = git(f.workspace, 'rev-parse', '--git-path', 'info/exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, 'ignoredDir\n');
  assert.throws(
    () =>
      new DelegationIntegration().apply({
        workspace: f.workspace,
        workspaceIdentity: workspaceIdentity(f.workspace),
        plan,
      }),
    /parent was redirected/i,
  );
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'outside remains\n');
});

test('applies a candidate from a dirty retained conversation before-image', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'a.txt'), 'conversation dirty\n');
  const workspaceBefore = createCheckpoint(f.workspace, f.evidence, {
    fixture: 'conversation-before',
  });
  const plan = new DelegationIntegration().prepare({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    evidenceDirectory: f.evidence,
    workspaceBefore: descriptor(workspaceBefore),
    target: descriptor(f.target),
    inputs: [
      {
        assignmentId: 'writer-two',
        source: descriptor(f.target),
        output: descriptor(f.outputs[1]),
      },
    ],
  });
  new DelegationIntegration().apply({
    workspace: f.workspace,
    workspaceIdentity: workspaceIdentity(f.workspace),
    plan,
  });
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'base a\n');
  assert.equal(readFileSync(join(f.workspace, 'b.txt'), 'utf8'), 'writer two\n');
});
