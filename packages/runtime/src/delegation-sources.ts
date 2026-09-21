import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { WorkspaceIdentity } from './contracts.js';
import { readCheckpoint, createCheckpoint } from './checkpoint-storage.js';
import { restoreCheckpointWorktree } from './checkpoint-workspace.js';
import { Checkpoints } from './checkpoints.js';
import type { DelegationAssignment } from './delegation-plan.js';
import {
  DelegationRecords,
  type DelegationAttempt,
  type DelegationAuthorization,
  type DelegationPlanRevision,
  type DelegationSourceSnapshot,
  type DelegationTask,
} from './delegation-records.js';
import { DelegationTasks } from './delegation-tasks.js';
import { Store } from './store.js';
import { canonicalJson } from './canonical-json.js';
import { assertWorkspaceIdentity, workspaceIdentity } from './workspace-identity.js';

export type DelegationOutputResolution = { attemptId: string; source: DelegationSourceSnapshot };
export type DelegationOutputResolver = (input: {
  runId: string;
  authorizationId: string;
  producerTaskId: string;
  consumerTaskId: string;
}) => DelegationOutputResolution;
export type PreparedDelegationSource = {
  workspace: string;
  workspaceIdentity: WorkspaceIdentity;
  source: DelegationSourceSnapshot;
};

type BoundAttempt = DelegationAttempt;
type Authority = {
  task: DelegationTask;
  authorization: DelegationAuthorization;
  plan: DelegationPlanRevision;
  assignment: DelegationAssignment;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function source(value: unknown, producerTaskId?: string): DelegationSourceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Delegation source descriptor is invalid.');
  const item = value as Record<string, unknown>;
  if (
    typeof item.checkpointDirectory !== 'string' ||
    !isAbsolute(item.checkpointDirectory) ||
    typeof item.checkpointDigest !== 'string' ||
    !sha256.test(item.checkpointDigest) ||
    typeof item.treeOid !== 'string' ||
    !oid.test(item.treeOid) ||
    (item.producerTaskId !== undefined && typeof item.producerTaskId !== 'string') ||
    (producerTaskId !== undefined && item.producerTaskId !== producerTaskId)
  )
    throw new Error('Delegation source descriptor is invalid.');
  return {
    checkpointDirectory: item.checkpointDirectory,
    checkpointDigest: item.checkpointDigest,
    treeOid: item.treeOid,
    ...(item.producerTaskId === undefined ? {} : { producerTaskId: item.producerTaskId }),
  };
}

function assertManifest(descriptor: DelegationSourceSnapshot): void {
  const manifest = readCheckpoint(descriptor.checkpointDirectory, descriptor.checkpointDigest);
  if (
    manifest.directory !== descriptor.checkpointDirectory ||
    manifest.snapshotTreeOid !== descriptor.treeOid
  )
    throw new Error('Delegation source snapshot does not match its retained checkpoint.');
}

export class DelegationSources {
  private readonly records: DelegationRecords;
  private readonly checkpoints: Checkpoints;
  private readonly tasks: DelegationTasks;
  constructor(
    private readonly store: Store,
    private readonly outputs: DelegationOutputResolver,
  ) {
    this.records = new DelegationRecords(store);
    this.checkpoints = new Checkpoints(store);
    this.tasks = new DelegationTasks(store);
  }

  private authority(runId: string, taskId: string): Authority {
    const task = this.records.tasks(runId).find((item) => item.id === taskId);
    if (!task) throw new Error('Delegation task belongs to another run or does not exist.');
    const authorization = this.records
      .authorizations(runId)
      .find((item) => item.id === task.authorizationId && !item.revokedAt);
    const plans = this.records.plans(runId),
      plan = authorization && plans.at(-1);
    const assignment = plan?.plan.assignments.find((item) => item.id === task.assignmentId);
    if (
      !authorization ||
      !plan ||
      plan.id !== authorization.planId ||
      plan.disposition !== 'authorized' ||
      plan.digest !== authorization.digest ||
      plan.basisDigest !== authorization.basisDigest ||
      !assignment
    )
      throw new Error(
        'Delegation task lacks its current exact active authorization and assignment.',
      );
    return { task, authorization, plan, assignment };
  }

  private attempt(task: DelegationTask, attemptId: string): BoundAttempt {
    if (!uuid.test(attemptId)) throw new Error('Delegation attempt ID must be a UUID.');
    const attempt = task.attempts.find((item) => item.id === attemptId) as BoundAttempt | undefined;
    if (!attempt) throw new Error('Delegation source operation requires a recorded task attempt.');
    return attempt;
  }

  private resolve(authority: Authority): DelegationSourceSnapshot {
    if (authority.assignment.source === 'run-basis') {
      const checkpointDigest = authority.plan.basis.checkpointDigest;
      if (typeof checkpointDigest !== 'string')
        throw new Error('Authorized run basis lacks its retained checkpoint digest.');
      const selected = this.checkpoints.selected(authority.task.runId, checkpointDigest);
      if (authority.plan.basis.sourceTreeOid !== selected.checkpoint.snapshotTreeOid)
        throw new Error(
          'Authorized run basis tree does not match its selected retained checkpoint.',
        );
      return {
        checkpointDirectory: selected.checkpoint.directory,
        checkpointDigest: selected.checkpoint.digest,
        treeOid: selected.checkpoint.snapshotTreeOid,
      };
    }
    const assignmentId = authority.assignment.source.slice('output:'.length);
    const producer = this.records
      .tasks(authority.task.runId)
      .find(
        (task) =>
          task.assignmentId === assignmentId && task.authorizationId === authority.authorization.id,
      );
    if (
      !producer ||
      !authority.task.dependencies.includes(producer.id) ||
      producer.state !== 'completed'
    )
      throw new Error('Delegation output source is not a completed explicit dependency.');
    const output = this.outputs({
      runId: authority.task.runId,
      authorizationId: authority.authorization.id,
      producerTaskId: producer.id,
      consumerTaskId: authority.task.id,
    });
    const attempt = this.attempt(producer, output.attemptId);
    if (
      attempt.status !== 'completed' ||
      attempt.cleanupConfirmed !== true ||
      !attempt.source ||
      !attempt.result?.source ||
      !same(attempt.result.source, output.source)
    )
      throw new Error(
        "Delegation output source is not the producer's exact completed attempt output with confirmed cleanup.",
      );
    const descriptor = source(output.source, producer.id);
    assertManifest(descriptor);
    const manifest = readCheckpoint(descriptor.checkpointDirectory, descriptor.checkpointDigest);
    if (
      !same(manifest.metadata, {
        runId: authority.task.runId,
        authorizationId: authority.authorization.id,
        taskId: producer.id,
        attemptId: attempt.id,
        source: attempt.source,
      })
    )
      throw new Error(
        'Delegation output checkpoint metadata does not bind the exact producer attempt source.',
      );
    return descriptor;
  }

  prepare(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    workspaceId: string;
  }): PreparedDelegationSource {
    if (!uuid.test(input.workspaceId)) throw new Error('Delegation workspace ID must be a UUID.');
    const authority = this.authority(input.runId, input.taskId),
      attempt = this.attempt(authority.task, input.attemptId),
      session =
        attempt.sessionId &&
        this.records.sessions(input.runId).find((item) => item.id === attempt.sessionId);
    if (
      attempt.status !== 'dispatching' ||
      attempt.source ||
      attempt.workspace ||
      !session ||
      session.taskId !== authority.task.id ||
      session.state !== 'prepared'
    )
      throw new Error(
        'Delegation source preparation requires one unprepared claimed attempt and prepared session.',
      );
    const generation = attempt.controlGeneration;
    if (generation === undefined || !Number.isSafeInteger(generation))
      throw new Error('Delegation source preparation requires its recorded control generation.');
    this.tasks.assertAdmission({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      expectedGeneration: generation,
    });
    const project = this.store
      .projects()
      .find(
        (item) => item.id === this.store.runs().find((run) => run.id === input.runId)?.projectId,
      );
    if (!project) throw new Error('Delegation source project does not exist.');
    const descriptor = this.resolve(authority);
    this.tasks.beginPreparation({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      sessionId: session.id,
      expectedGeneration: generation,
      workspaceId: input.workspaceId,
      source: descriptor,
    });
    const preparation = this.attempt(
      this.authority(input.runId, input.taskId).task,
      input.attemptId,
    ).preparation;
    if (preparation?.state === 'completed') {
      if (!same(preparation.source, descriptor) || !preparation.workspace)
        throw new Error(
          'Delegation preparation receipt is incomplete or does not match its source.',
        );
      const retainedIdentity = workspaceIdentity(preparation.workspace.path);
      if (!same(retainedIdentity, preparation.workspace.identity))
        throw new Error('Delegation preparation workspace identity changed after its receipt.');
      return {
        workspace: preparation.workspace.path,
        workspaceIdentity: retainedIdentity,
        source: descriptor,
      };
    }
    if (preparation?.state !== 'intent')
      throw new Error('Delegation preparation intent was not retained.');
    const restored = restoreCheckpointWorktree(
      descriptor.checkpointDirectory,
      descriptor.checkpointDigest,
      project.root,
      input.workspaceId,
    );
    if (restored.manifest.snapshotTreeOid !== descriptor.treeOid)
      throw new Error('Delegation materialized workspace differs from its retained source tree.');
    const restoredIdentity = workspaceIdentity(restored.workspace);
    this.tasks.completePreparation({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      sessionId: session.id,
      expectedGeneration: preparation.generation,
      workspace: { path: restored.workspace, identity: restoredIdentity },
    });
    return {
      workspace: restored.workspace,
      workspaceIdentity: restoredIdentity,
      source: descriptor,
    };
  }

  capture(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedGeneration: number;
    workspace: string;
    workspaceIdentity: WorkspaceIdentity;
  }): DelegationSourceSnapshot {
    const authority = this.authority(input.runId, input.taskId),
      attempt = this.attempt(authority.task, input.attemptId);
    const session =
      attempt.sessionId &&
      this.records.sessions(input.runId).find((item) => item.id === attempt.sessionId);
    if (
      !attempt.workspace ||
      !attempt.source ||
      attempt.workspace.path !== input.workspace ||
      !same(attempt.workspace.identity, input.workspaceIdentity) ||
      !session ||
      session.taskId !== authority.task.id ||
      session.state !== 'completed' ||
      session.cleanupConfirmed !== true
    )
      throw new Error(
        'Delegation output capture requires the recorded attempt workspace, source identity, and confirmed completed native session.',
      );
    const generation = input.expectedGeneration;
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error(
        'Delegation output capture requires the current runtime-stage control generation.',
      );
    this.tasks.beginOutputPublication({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      sessionId: session.id,
      expectedGeneration: generation,
    });
    const publication = this.attempt(
      this.authority(input.runId, input.taskId).task,
      input.attemptId,
    ).outputPublication;
    if (publication?.state === 'completed' && publication.source) {
      const retained = source(publication.source, authority.task.id);
      assertManifest(retained);
      return retained;
    }
    if (publication?.state !== 'intent' || !Number.isSafeInteger(publication.generation))
      throw new Error('Delegation output publication intent was not retained.');
    assertWorkspaceIdentity(input.workspace, input.workspaceIdentity);
    const currentSource = this.resolve(authority);
    if (!same(attempt.source, currentSource))
      throw new Error(
        'Delegation output capture source does not match the recorded attempt source.',
      );
    const run = this.store.runs().find((item) => item.id === input.runId);
    if (!run) throw new Error('Delegation source run does not exist.');
    const dataRoot = realpathSync(this.store.root),
      runDirectory = join(dataRoot, relative(this.store.root, this.store.runDirectory(run)));
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    if (realpathSync(runDirectory) !== runDirectory)
      throw new Error('Delegation run evidence directory was redirected.');
    const evidenceDirectory = join(runDirectory, 'delegation', input.attemptId, 'output');
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    if (realpathSync(evidenceDirectory) !== evidenceDirectory)
      throw new Error('Delegation output evidence directory was redirected.');
    const manifest = createCheckpoint(input.workspace, evidenceDirectory, {
      runId: input.runId,
      authorizationId: authority.authorization.id,
      taskId: authority.task.id,
      attemptId: attempt.id,
      source: attempt.source,
    });
    assertWorkspaceIdentity(input.workspace, input.workspaceIdentity);
    const retained = {
      checkpointDirectory: manifest.directory,
      checkpointDigest: manifest.digest,
      treeOid: manifest.snapshotTreeOid,
      producerTaskId: authority.task.id,
    };
    this.tasks.completeOutputPublication({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      sessionId: session.id,
      expectedGeneration: publication.generation,
      source: retained,
    });
    return retained;
  }
}
