import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createCheckpoint, readCheckpoint } from './checkpoint-storage.js';
import { Checkpoints } from './checkpoints.js';
import { DelegationControls } from './delegation-control.js';
import { DelegationIntegration, type DelegationIntegrationPlan } from './delegation-integration.js';
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
import { assertWorkspaceIdentity, workspaceIdentity } from './workspace-identity.js';
import type { WorkspaceLeasePort } from './workspace-leases.js';
import { now } from './runtime-status.js';
import { canonicalJson } from './canonical-json.js';

export type IntegrationReceipt = {
  state: 'intent' | 'prepared' | 'applied';
  generation: number;
  plan?: DelegationIntegrationPlan;
  createdAt: string;
  updatedAt: string;
};
type Attempt = DelegationAttempt & { integration?: IntegrationReceipt };
type Authority = {
  task: DelegationTask;
  authorization: DelegationAuthorization;
  plan: DelegationPlanRevision;
};
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));

/** Durable candidate receipt for the main-integration task. It prepares data only; native dispatch remains the runner's authority. */
export class DelegationIntegrationStage {
  private readonly records: DelegationRecords;
  private readonly tasks: DelegationTasks;
  private readonly controls: DelegationControls;
  private readonly checkpoints: Checkpoints;
  constructor(
    private readonly store: Store,
    private readonly leases: WorkspaceLeasePort,
    private readonly integration = new DelegationIntegration(),
    controls = new DelegationControls(store),
  ) {
    this.records = new DelegationRecords(store);
    this.tasks = new DelegationTasks(store);
    this.controls = controls;
    this.checkpoints = new Checkpoints(store);
  }

  private authority(runId: string, taskId: string): Authority {
    const task = this.records.tasks(runId).find((item) => item.id === taskId);
    const authorization =
      task &&
      this.records
        .authorizations(runId)
        .find((item) => item.id === task.authorizationId && !item.revokedAt);
    const plan = authorization && this.records.plans(runId).at(-1);
    const assignment = plan?.plan.assignments.find((item) => item.id === task?.assignmentId);
    if (
      !task ||
      !authorization ||
      !plan ||
      plan.id !== authorization.planId ||
      plan.disposition !== 'authorized' ||
      plan.digest !== authorization.digest ||
      plan.basisDigest !== authorization.basisDigest ||
      assignment?.role !== 'main-integration'
    )
      throw new Error('Integration requires the current exact authorized main-integration task.');
    return { task, authorization, plan };
  }
  private attempt(authority: Authority, attemptId: string): Attempt {
    const attempt = authority.task.attempts.find((item) => item.id === attemptId) as
      | Attempt
      | undefined;
    if (
      !attempt ||
      attempt.status !== 'dispatching' ||
      !attempt.sessionId ||
      !Number.isSafeInteger(attempt.controlGeneration)
    )
      throw new Error('Integration requires a recorded dispatching task attempt.');
    return attempt;
  }
  private lease(
    runId: string,
    attemptId: string,
    input: { reservationId: string; generation: number },
  ): void {
    const run = this.store.runs().find((item) => item.id === runId);
    const identity = run && workspaceIdentity(run.workspace);
    const lease = this.leases.snapshot().find((item) => item.reservationId === input.reservationId);
    if (
      !run ||
      !run.workspaceIdentity ||
      input.reservationId !== attemptId ||
      !lease ||
      lease.state !== 'active' ||
      lease.runId !== runId ||
      lease.workspace !== run.workspace ||
      lease.generation !== input.generation ||
      !lease.identity ||
      !identity ||
      lease.identity.device !== identity.device ||
      lease.identity.inode !== identity.inode
    )
      throw new Error(
        'Integration requires the exact active conversation-workspace lease for this attempt.',
      );
    assertWorkspaceIdentity(run.workspace, run.workspaceIdentity);
  }
  private source(authority: Authority, assignmentId: string): DelegationSourceSnapshot {
    const assignment = authority.plan.plan.assignments.find((item) => item.id === assignmentId);
    if (!assignment) throw new Error('Integration source assignment is missing.');
    if (assignment.source === 'run-basis') {
      const digest = authority.plan.basis.checkpointDigest;
      if (typeof digest !== 'string')
        throw new Error('Authorized run basis is missing its checkpoint.');
      const selected = this.checkpoints.selected(authority.task.runId, digest);
      if (selected.checkpoint.snapshotTreeOid !== authority.plan.basis.sourceTreeOid)
        throw new Error('Authorized run basis tree is stale.');
      return {
        checkpointDirectory: selected.checkpoint.directory,
        checkpointDigest: selected.checkpoint.digest,
        treeOid: selected.checkpoint.snapshotTreeOid,
      };
    }
    const producerAssignment = assignment.source.slice('output:'.length),
      producer = this.records
        .tasks(authority.task.runId)
        .find(
          (task) =>
            task.authorizationId === authority.authorization.id &&
            task.assignmentId === producerAssignment,
        );
    if (!producer || !authority.task.dependencies.includes(producer.id))
      throw new Error('Integration declared source is not an explicit task dependency.');
    const output = this.tasks.completedOutput({
      runId: authority.task.runId,
      authorizationId: authority.authorization.id,
      producerTaskId: producer.id,
      consumerTaskId: authority.task.id,
    });
    const attempt = output && producer.attempts.find((item) => item.id === output.attemptId);
    if (
      !output ||
      !attempt?.source ||
      !attempt.result?.source ||
      !same(attempt.result.source, output.source)
    )
      throw new Error(
        'Integration declared source lacks an exact cleanup-confirmed completed output.',
      );
    const manifest = readCheckpoint(
      output.source.checkpointDirectory,
      output.source.checkpointDigest,
    );
    if (
      manifest.snapshotTreeOid !== output.source.treeOid ||
      !same(manifest.metadata, {
        runId: authority.task.runId,
        authorizationId: authority.authorization.id,
        taskId: producer.id,
        attemptId: attempt.id,
        source: attempt.source,
      })
    )
      throw new Error('Integration output checkpoint metadata does not bind its producer attempt.');
    return structuredClone(output.source);
  }
  private inputs(
    authority: Authority,
  ): Array<{
    assignmentId: string;
    source: DelegationSourceSnapshot;
    output: DelegationSourceSnapshot;
  }> {
    const assignment = authority.plan.plan.assignments.find(
      (item) => item.id === authority.task.assignmentId,
    )!;
    return (assignment.integrationInputs ?? []).map((assignmentId) => {
      const producer = this.records
        .tasks(authority.task.runId)
        .find(
          (task) =>
            task.authorizationId === authority.authorization.id &&
            task.assignmentId === assignmentId,
        );
      if (!producer || !authority.task.dependencies.includes(producer.id))
        throw new Error('Integration input is not an explicit same-authorization dependency.');
      const output = this.tasks.completedOutput({
        runId: authority.task.runId,
        authorizationId: authority.authorization.id,
        producerTaskId: producer.id,
        consumerTaskId: authority.task.id,
      });
      const attempt = output && producer.attempts.find((item) => item.id === output.attemptId);
      if (
        !output ||
        !attempt?.source ||
        !attempt.result?.source ||
        !same(attempt.result.source, output.source)
      )
        throw new Error('Integration input lacks an exact cleanup-confirmed completed output.');
      const manifest = readCheckpoint(
        output.source.checkpointDirectory,
        output.source.checkpointDigest,
      );
      if (
        manifest.snapshotTreeOid !== output.source.treeOid ||
        !same(manifest.metadata, {
          runId: authority.task.runId,
          authorizationId: authority.authorization.id,
          taskId: producer.id,
          attemptId: attempt.id,
          source: attempt.source,
        })
      )
        throw new Error(
          'Integration input checkpoint metadata does not bind its producer attempt.',
        );
      return {
        assignmentId,
        source: structuredClone(attempt.source),
        output: structuredClone(output.source),
      };
    });
  }
  private update(task: DelegationTask): void {
    this.store.db
      .prepare('UPDATE delegation_tasks SET document=? WHERE id=?')
      .run(JSON.stringify(task), task.id);
  }
  private receipt(authority: Authority, attemptId: string): Attempt {
    return this.attempt(authority, attemptId);
  }
  private evidence(runId: string, attemptId: string): string {
    const run = this.store.runs().find((item) => item.id === runId)!;
    const path = join(this.store.runDirectory(run), 'delegation', attemptId, 'integration');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (realpathSync(path) !== path)
      throw new Error('Integration evidence directory was redirected.');
    return path;
  }
  prepare(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedGeneration: number;
    lease: { reservationId: string; generation: number };
  }): DelegationIntegrationPlan {
    const authority = this.authority(input.runId, input.taskId),
      attempt = this.attempt(authority, input.attemptId);
    this.lease(input.runId, input.attemptId, input.lease);
    this.tasks.assertRuntimeStage({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      expectedGeneration: input.expectedGeneration,
    });
    if (attempt.integration?.state === 'prepared' || attempt.integration?.state === 'applied')
      return attempt.integration.plan!;
    if (attempt.integration)
      throw new Error('Integration has a stranded intent and requires recovery.');
    const activity = this.controls.begin(
      input.runId,
      input.expectedGeneration,
      `integration:${input.attemptId}:prepare`,
      'integration-preparation',
    );
    try {
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      const target = this.source(authority, authority.task.assignmentId),
        inputs = this.inputs(authority),
        evidenceDirectory = this.evidence(input.runId, input.attemptId);
      const manifest = createCheckpoint(run.workspace, evidenceDirectory, {
        runId: input.runId,
        authorizationId: authority.authorization.id,
        taskId: authority.task.id,
        attemptId: input.attemptId,
        purpose: 'integration-workspace-before',
      });
      if (manifest.snapshotTreeOid !== authority.plan.basis.sourceTreeOid)
        throw new Error('Conversation workspace no longer matches the authorized run basis.');
      const workspaceBefore = {
        checkpointDirectory: manifest.directory,
        checkpointDigest: manifest.digest,
        treeOid: manifest.snapshotTreeOid,
      };
      this.store.transaction(() => {
        const current = this.receipt(this.authority(input.runId, input.taskId), input.attemptId);
        if (current.integration) throw new Error('Integration receipt changed before intent.');
        current.integration = {
          state: 'intent',
          generation: input.expectedGeneration,
          createdAt: now(),
          updatedAt: now(),
        };
        const task = this.authority(input.runId, input.taskId).task;
        task.attempts = task.attempts.map((item) => (item.id === current.id ? current : item));
        this.update(task);
      });
      const plan = this.integration.prepare({
        workspace: run.workspace,
        workspaceIdentity: workspaceIdentity(run.workspace),
        evidenceDirectory,
        workspaceBefore,
        target,
        inputs,
      });
      this.store.transaction(() => {
        const current = this.receipt(this.authority(input.runId, input.taskId), input.attemptId);
        if (
          !current.integration ||
          current.integration.state !== 'intent' ||
          current.integration.plan
        )
          throw new Error('Integration intent changed before candidate retention.');
        current.integration = { ...current.integration, state: 'prepared', plan, updatedAt: now() };
        const task = this.authority(input.runId, input.taskId).task;
        task.attempts = task.attempts.map((item) => (item.id === current.id ? current : item));
        this.update(task);
      });
      this.controls.finish(input.runId, activity.token, {
        confirmed: true,
        evidence: { candidate: plan.candidate.checkpointDigest },
      });
      return plan;
    } catch (error) {
      try {
        this.controls.finish(input.runId, activity.token, {
          confirmed: true,
          evidence: { operation: 'candidate-preparation-failed' },
        });
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
  }
  candidate(input: { runId: string; taskId: string; attemptId: string }): DelegationSourceSnapshot {
    const attempt = this.receipt(this.authority(input.runId, input.taskId), input.attemptId),
      plan = attempt.integration?.plan;
    if (!plan || attempt.integration?.state !== 'applied')
      throw new Error(
        'Integration candidate is not durably applied to the conversation workspace.',
      );
    const manifest = readCheckpoint(
      plan.candidate.checkpointDirectory,
      plan.candidate.checkpointDigest,
    );
    if (manifest.snapshotTreeOid !== plan.candidate.treeOid)
      throw new Error('Integration candidate receipt is corrupt.');
    return structuredClone(plan.candidate);
  }
  apply(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedGeneration: number;
    lease: { reservationId: string; generation: number };
  }): DelegationIntegrationPlan {
    const authority = this.authority(input.runId, input.taskId),
      attempt = this.attempt(authority, input.attemptId);
    this.lease(input.runId, input.attemptId, input.lease);
    this.tasks.assertRuntimeStage({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      expectedGeneration: input.expectedGeneration,
    });
    if (attempt.integration?.state !== 'prepared' || !attempt.integration.plan)
      throw new Error('Integration apply requires one prepared current candidate.');
    const plan = attempt.integration.plan,
      activity = this.controls.begin(
        input.runId,
        input.expectedGeneration,
        `integration:${input.attemptId}:apply`,
        'integration-preparation',
      );
    try {
      this.store.transaction(() => {
        const current = this.receipt(this.authority(input.runId, input.taskId), input.attemptId);
        if (current.integration?.state !== 'prepared' || !same(current.integration.plan, plan))
          throw new Error('Integration candidate changed before apply intent.');
        current.integration = { ...current.integration, state: 'intent', updatedAt: now() };
        const task = this.authority(input.runId, input.taskId).task;
        task.attempts = task.attempts.map((item) => (item.id === current.id ? current : item));
        this.update(task);
      });
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.integration.apply({
        workspace: run.workspace,
        workspaceIdentity: workspaceIdentity(run.workspace),
        plan,
      });
      this.store.transaction(() => {
        const current = this.receipt(this.authority(input.runId, input.taskId), input.attemptId);
        if (current.integration?.state !== 'intent' || !same(current.integration.plan, plan))
          throw new Error('Integration apply intent changed during file application.');
        current.integration = { ...current.integration, state: 'applied', updatedAt: now() };
        const task = this.authority(input.runId, input.taskId).task;
        task.attempts = task.attempts.map((item) => (item.id === current.id ? current : item));
        this.update(task);
      });
      this.controls.finish(input.runId, activity.token, {
        confirmed: true,
        evidence: { candidate: plan.candidate.checkpointDigest },
      });
      return plan;
    } catch (error) {
      try {
        this.controls.finish(input.runId, activity.token, { confirmed: false });
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
  }
}
