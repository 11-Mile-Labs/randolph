import { readCheckpoint } from './checkpoint-storage.js';
import { Checkpoints } from './checkpoints.js';
import {
  DelegationRecords,
  type DelegationAuthorization,
  type DelegationPlanRevision,
  type DelegationSourceSnapshot,
  type DelegationTask,
} from './delegation-records.js';
import { DelegationTasks } from './delegation-tasks.js';
import { Store } from './store.js';
import { canonicalJson } from './canonical-json.js';

/** Exact-authority triple. Only DelegationIntegrationStage.authority() may prove one; resolvers never synthesize it. */
export type Authority = {
  task: DelegationTask;
  authorization: DelegationAuthorization;
  plan: DelegationPlanRevision;
};
export const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));

/** Provenance resolution for the integration target and inputs. It reads and validates only; every write and transaction stays in DelegationIntegrationStage. */
export class DelegationIntegrationSources {
  private readonly records: DelegationRecords;
  private readonly checkpoints: Checkpoints;
  constructor(
    store: Store,
    private readonly tasks: DelegationTasks,
  ) {
    this.records = new DelegationRecords(store);
    this.checkpoints = new Checkpoints(store);
  }

  resolveTarget(authority: Authority, assignmentId: string): DelegationSourceSnapshot {
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
  resolveInputs(authority: Authority): Array<{
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
}
