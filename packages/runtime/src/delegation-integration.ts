import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createCheckpoint, readCheckpoint, restoreCheckpoint } from './checkpoint-storage.js';
import { importCheckpointObjects } from './checkpoint-workspace.js';
import type { WorkspaceIdentity } from './contracts.js';
import type { DelegationSourceSnapshot } from './delegation-records.js';
import { runSafeGit } from './git-execution.js';
import { captureGitTree } from './git-workspace-snapshot.js';
import { assertWorkspaceIdentity } from './workspace-identity.js';

type Entry = { mode: '100644' | '100755' | '120000'; oid: string };
export type DelegationIntegrationInput = {
  assignmentId: string;
  source: DelegationSourceSnapshot;
  output: DelegationSourceSnapshot;
};
export type DelegationIntegrationTransition = { path: string; before?: Entry; after?: Entry };
export type DelegationIntegrationPlan = {
  workspaceBefore: DelegationSourceSnapshot;
  target: DelegationSourceSnapshot;
  candidate: DelegationSourceSnapshot;
  inputs: DelegationIntegrationInput[];
  processedInputs: string[];
  pendingInputs: string[];
  complete: boolean;
  changes: DelegationIntegrationTransition[];
  conflicts: string[];
  evidenceDirectory: string;
};
const oid = /^[0-9a-f]{40,64}$/;
const equal = (a?: Entry, b?: Entry): boolean => a?.mode === b?.mode && a?.oid === b?.oid;
const text = (root: string, args: string[], input?: string): string =>
  runSafeGit(root, args, input).toString('utf8').trim();
function sameSource(value: unknown, expected: DelegationSourceSnapshot): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    source.checkpointDirectory === expected.checkpointDirectory &&
    source.checkpointDigest === expected.checkpointDigest &&
    source.treeOid === expected.treeOid &&
    source.producerTaskId === expected.producerTaskId
  );
}

function entries(root: string, tree: string): Map<string, Entry> {
  if (!oid.test(tree)) throw new Error('Integration tree identity is invalid.');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(
    runSafeGit(root, ['ls-tree', '-r', '-z', tree]),
  );
  const result = new Map<string, Entry>();
  for (const row of raw.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t(.+)$/.exec(row);
    if (
      !match ||
      match[3].startsWith('/') ||
      match[3]
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    )
      throw new Error('Integration snapshot contains an unsupported path or entry.');
    result.set(match[3], { mode: match[1] as Entry['mode'], oid: match[2] });
  }
  return result;
}
function descriptor(value: DelegationSourceSnapshot): DelegationSourceSnapshot {
  const manifest = readCheckpoint(value.checkpointDirectory, value.checkpointDigest);
  if (manifest.snapshotTreeOid !== value.treeOid)
    throw new Error('Integration source descriptor does not match its checkpoint.');
  return { ...value };
}
function commit(root: string, tree: string, parent?: string): string {
  return text(
    root,
    ['hash-object', '-w', '-t', 'commit', '--stdin'],
    `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Randolph Integration <checkpoint@localhost> 0 +0000\ncommitter Randolph Integration <checkpoint@localhost> 0 +0000\n\nRetained integration merge input.\n`,
  );
}
function importSnapshot(root: string, source: DelegationSourceSnapshot): void {
  const manifest = readCheckpoint(source.checkpointDirectory, source.checkpointDigest);
  const common = realpathSync(
    text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  importCheckpointObjects(root, common, manifest);
}
function materialize(root: string, tree: string): void {
  runSafeGit(root, ['read-tree', '--reset', '-u', tree]);
}
function safe(path: string, workspace: string): string {
  const target = join(workspace, path);
  if (!target.startsWith(workspace + sep))
    throw new Error('Integration path escaped its workspace.');
  return target;
}
function changes(
  before: Map<string, Entry>,
  after: Map<string, Entry>,
): DelegationIntegrationTransition[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((path) =>
      equal(before.get(path), after.get(path))
        ? []
        : [{ path, before: before.get(path), after: after.get(path) }],
    );
}
function sameChanges(
  left: DelegationIntegrationTransition[],
  right: DelegationIntegrationTransition[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameTransition(value: unknown, expected: DelegationIntegrationTransition): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const transition = value as { path?: unknown; before?: Entry; after?: Entry };
  return (
    transition.path === expected.path &&
    equal(transition.before, expected.before) &&
    equal(transition.after, expected.after)
  );
}
function assertDestinationParent(workspace: string, path: string): void {
  let current = workspace;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      const state = lstatSync(current);
      if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(current) !== current)
        throw new Error('Integration destination parent was redirected.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
}
function destinationParent(workspace: string, path: string): void {
  assertDestinationParent(workspace, path);
  let current = workspace;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o700 });
      const state = lstatSync(current);
      if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(current) !== current)
        throw new Error('Integration destination parent was redirected.');
    }
  }
}

export class DelegationIntegration {
  prepare(input: {
    workspace: string;
    workspaceIdentity: WorkspaceIdentity;
    evidenceDirectory: string;
    workspaceBefore?: DelegationSourceSnapshot;
    target: DelegationSourceSnapshot;
    inputs: DelegationIntegrationInput[];
  }): DelegationIntegrationPlan {
    assertWorkspaceIdentity(input.workspace, input.workspaceIdentity);
    const workspaceBefore = descriptor(input.workspaceBefore ?? input.target),
      target = descriptor(input.target);
    if (
      !Array.isArray(input.inputs) ||
      !input.inputs.length ||
      input.inputs.length > 16 ||
      new Set(input.inputs.map((item) => item.assignmentId)).size !== input.inputs.length
    )
      throw new Error('Integration inputs must be a bounded unique list.');
    mkdirSync(input.evidenceDirectory, { recursive: true, mode: 0o700 });
    if (realpathSync(input.evidenceDirectory) !== input.evidenceDirectory)
      throw new Error('Integration evidence directory was redirected.');
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'randolph-integration-')),
      sandbox = join(temporary, 'tree');
    try {
      restoreCheckpoint(
        workspaceBefore.checkpointDirectory,
        workspaceBefore.checkpointDigest,
        sandbox,
      );
      importSnapshot(sandbox, target);
      let candidateTree = target.treeOid;
      const conflicts: string[] = [];
      const processedInputs: string[] = [];
      for (const item of input.inputs) {
        if (!/^[a-z][a-z0-9-]*$/.test(item.assignmentId))
          throw new Error('Integration assignment ID is invalid.');
        const base = descriptor(item.source),
          output = descriptor(item.output);
        importSnapshot(sandbox, base);
        importSnapshot(sandbox, output);
        const baseCommit = commit(sandbox, base.treeOid),
          ours = commit(sandbox, candidateTree, baseCommit),
          theirs = commit(sandbox, output.treeOid, baseCommit);
        const merged = runSafeGit(
          sandbox,
          ['merge-tree', '--write-tree', '--stdin', '--name-only', '-z'],
          `${ours} ${theirs}\n`,
        )
          .toString('utf8')
          .split('\0');
        if (!['0', '1'].includes(merged[0]) || !oid.test(merged[1] ?? ''))
          throw new Error('Git returned an unsupported integration merge result.');
        candidateTree = merged[1];
        const end = merged.indexOf('', 2);
        if (end < 0) throw new Error('Git returned incomplete integration conflict evidence.');
        const conflictPaths = merged.slice(2, end).filter(Boolean);
        if ((merged[0] === '0') !== Boolean(conflictPaths.length))
          throw new Error('Git returned inconsistent integration conflict evidence.');
        conflicts.push(...conflictPaths.map((path) => `${item.assignmentId}:${path}`));
        processedInputs.push(item.assignmentId);
        if (conflictPaths.length) break;
      }
      const pendingInputs = input.inputs
        .map((item) => item.assignmentId)
        .filter((assignmentId) => !processedInputs.includes(assignmentId));
      const complete = !conflicts.length && !pendingInputs.length;
      materialize(sandbox, candidateTree);
      const retainedChanges = changes(
        entries(sandbox, workspaceBefore.treeOid),
        entries(sandbox, candidateTree),
      );
      const manifest = createCheckpoint(sandbox, input.evidenceDirectory, {
        schemaVersion: 1,
        workspaceBefore,
        target,
        inputs: input.inputs,
        processedInputs,
        pendingInputs,
        complete,
        changes: retainedChanges,
        conflicts,
        candidateTreeOid: candidateTree,
      });
      assertWorkspaceIdentity(input.workspace, input.workspaceIdentity);
      return {
        workspaceBefore,
        target,
        candidate: {
          checkpointDirectory: manifest.directory,
          checkpointDigest: manifest.digest,
          treeOid: manifest.snapshotTreeOid,
        },
        inputs: input.inputs.map((item) => ({
          assignmentId: item.assignmentId,
          source: descriptor(item.source),
          output: descriptor(item.output),
        })),
        processedInputs,
        pendingInputs,
        complete,
        changes: retainedChanges,
        conflicts,
        evidenceDirectory: input.evidenceDirectory,
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  apply(input: {
    workspace: string;
    workspaceIdentity: WorkspaceIdentity;
    plan: DelegationIntegrationPlan;
  }): DelegationIntegrationPlan {
    assertWorkspaceIdentity(input.workspace, input.workspaceIdentity);
    const workspaceBefore = descriptor(input.plan.workspaceBefore),
      target = descriptor(input.plan.target),
      candidate = descriptor(input.plan.candidate);
    if (!input.plan.complete || input.plan.conflicts.length || input.plan.pendingInputs.length)
      throw new Error(
        'Integration candidate is incomplete or has unresolved conflicts; no workspace files were changed.',
      );
    if (captureGitTree(input.workspace, input.plan.evidenceDirectory) !== workspaceBefore.treeOid)
      throw new Error('Integration target workspace changed after candidate preparation.');
    const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'randolph-integration-')),
      sandbox = join(temporary, 'tree');
    try {
      const metadata = readCheckpoint(
        candidate.checkpointDirectory,
        candidate.checkpointDigest,
      ).metadata;
      if (!sameSource(metadata.workspaceBefore, workspaceBefore))
        throw new Error('Integration candidate workspace-before evidence does not match its plan.');
      if (!sameSource(metadata.target, target))
        throw new Error('Integration candidate target evidence does not match its plan.');
      if (
        !Array.isArray(metadata.inputs) ||
        metadata.inputs.length !== input.plan.inputs.length ||
        metadata.inputs.some(
          (value, index) =>
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            (value as Record<string, unknown>).assignmentId !==
              input.plan.inputs[index]?.assignmentId ||
            !sameSource(
              (value as Record<string, unknown>).source,
              input.plan.inputs[index].source,
            ) ||
            !sameSource((value as Record<string, unknown>).output, input.plan.inputs[index].output),
        )
      )
        throw new Error('Integration candidate inputs do not match its plan.');
      if (
        !Array.isArray(metadata.changes) ||
        metadata.changes.length !== input.plan.changes.length ||
        metadata.changes.some((value, index) => !sameTransition(value, input.plan.changes[index]))
      )
        throw new Error('Integration candidate changes do not match its plan.');
      if (
        JSON.stringify(metadata.processedInputs) !== JSON.stringify(input.plan.processedInputs) ||
        JSON.stringify(metadata.pendingInputs) !== JSON.stringify(input.plan.pendingInputs) ||
        metadata.complete !== input.plan.complete ||
        JSON.stringify(metadata.conflicts) !== JSON.stringify(input.plan.conflicts) ||
        metadata.candidateTreeOid !== candidate.treeOid
      )
        throw new Error('Integration candidate result evidence does not match its plan.');
      restoreCheckpoint(candidate.checkpointDirectory, candidate.checkpointDigest, sandbox);
      importSnapshot(sandbox, workspaceBefore);
      const before = entries(sandbox, workspaceBefore.treeOid),
        after = entries(sandbox, candidate.treeOid),
        retainedChanges = changes(before, after);
      if (!sameChanges(input.plan.changes, retainedChanges))
        throw new Error('Integration plan transitions do not match its retained candidate.');
      for (const transition of retainedChanges) {
        assertDestinationParent(input.workspace, transition.path);
        const destination = safe(transition.path, input.workspace);
        try {
          const state = lstatSync(destination);
          if (!transition.before)
            throw new Error(
              `Integration refuses an unexpected existing destination ${transition.path}.`,
            );
          if (state.isDirectory())
            throw new Error(`Integration cannot replace directory path ${transition.path}.`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (transition.before)
              throw new Error(`Integration before-image disappeared at ${transition.path}.`);
          } else throw error;
        }
      }
      assertWorkspaceIdentity(input.workspace, input.workspaceIdentity);
      if (captureGitTree(input.workspace, input.plan.evidenceDirectory) !== workspaceBefore.treeOid)
        throw new Error('Integration target workspace changed before raw-file apply.');
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        if (equal(before.get(path), after.get(path))) continue;
        const destination = safe(path, input.workspace),
          source = safe(path, sandbox);
        destinationParent(input.workspace, path);
        try {
          const state = lstatSync(destination);
          if (state.isDirectory())
            throw new Error(`Integration cannot replace directory path ${path}.`);
          unlinkSync(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const next = after.get(path);
        if (!next) continue;
        if (next.mode === '120000') symlinkSync(readlinkSync(source), destination);
        else
          writeFileSync(destination, readFileSync(source), {
            flag: 'wx',
            mode: next.mode === '100755' ? 0o755 : 0o644,
          });
      }
      assertWorkspaceIdentity(input.workspace, input.workspaceIdentity);
      if (captureGitTree(input.workspace, input.plan.evidenceDirectory) !== candidate.treeOid)
        throw new Error('Integration candidate could not be verified after raw-file apply.');
      return input.plan;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
