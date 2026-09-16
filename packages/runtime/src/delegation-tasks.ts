import type { DelegationAssignment } from './delegation-plan.js';
import { DelegationAttemptLifecycle } from './delegation-attempt-lifecycle.js';
import {
  DelegationRecords,
  type DelegationSession,
  type DelegationSourceSnapshot,
  type DelegationTask,
} from './delegation-records.js';
import { Store } from './store.js';
import { now } from './runtime-status.js';

/**
 * Kept as a private copy rather than shared with delegation-attempt-lifecycle.ts: the
 * lifecycle guardrail forbids exporting validation helpers from that module.
 */
const text = (value: unknown, label: string, maximum = 500): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`${label} must be bounded nonempty text.`);
  return value;
};

/** Durable task-attempt ledger. It admits and records intent but never launches a process. */
export class DelegationTasks {
  private readonly records: DelegationRecords;
  private readonly lifecycle: DelegationAttemptLifecycle;
  constructor(private readonly store: Store) {
    this.records = new DelegationRecords(store);
    this.lifecycle = new DelegationAttemptLifecycle(store);
  }

  private update(task: DelegationTask): void {
    this.store.db
      .prepare('UPDATE delegation_tasks SET document=? WHERE id=?')
      .run(JSON.stringify(task), task.id);
  }
  private sessionUpdate(session: DelegationSession): void {
    this.store.db
      .prepare('UPDATE delegation_sessions SET document=? WHERE id=?')
      .run(JSON.stringify(session), session.id);
  }
  private assignment(runId: string, task: DelegationTask): DelegationAssignment {
    const authorization = this.records
      .authorizations(runId)
      .find((item) => item.id === task.authorizationId);
    const plan =
      authorization && this.records.plans(runId).find((item) => item.id === authorization.planId);
    const assignment = plan?.plan.assignments.find((item) => item.id === task.assignmentId);
    if (!assignment) throw new Error('Task retained assignment does not exist.');
    return assignment;
  }

  /**
   * Per-attempt transitions own their transactions inside DelegationAttemptLifecycle; these
   * forwarders keep every existing call site on DelegationTasks unchanged.
   */
  assertAdmission(
    input: Parameters<DelegationAttemptLifecycle['assertAdmission']>[0],
  ): DelegationTask {
    return this.lifecycle.assertAdmission(input);
  }
  assertRuntimeStage(
    input: Parameters<DelegationAttemptLifecycle['assertRuntimeStage']>[0],
  ): DelegationTask {
    return this.lifecycle.assertRuntimeStage(input);
  }
  beginAttempt(input: Parameters<DelegationAttemptLifecycle['beginAttempt']>[0]): DelegationTask {
    return this.lifecycle.beginAttempt(input);
  }
  bindPreparedAttempt(
    input: Parameters<DelegationAttemptLifecycle['bindPreparedAttempt']>[0],
  ): DelegationTask {
    return this.lifecycle.bindPreparedAttempt(input);
  }
  readmittedPreparedAttempt(
    input: Parameters<DelegationAttemptLifecycle['readmittedPreparedAttempt']>[0],
  ): DelegationTask {
    return this.lifecycle.readmittedPreparedAttempt(input);
  }
  beginPreparation(
    input: Parameters<DelegationAttemptLifecycle['beginPreparation']>[0],
  ): DelegationTask {
    return this.lifecycle.beginPreparation(input);
  }
  completePreparation(
    input: Parameters<DelegationAttemptLifecycle['completePreparation']>[0],
  ): DelegationTask {
    return this.lifecycle.completePreparation(input);
  }
  dispatchAttempt(
    input: Parameters<DelegationAttemptLifecycle['dispatchAttempt']>[0],
  ): DelegationTask {
    return this.lifecycle.dispatchAttempt(input);
  }
  bindAttempt(input: Parameters<DelegationAttemptLifecycle['bindAttempt']>[0]): DelegationTask {
    return this.lifecycle.bindAttempt(input);
  }
  beginOutputPublication(
    input: Parameters<DelegationAttemptLifecycle['beginOutputPublication']>[0],
  ): DelegationTask {
    return this.lifecycle.beginOutputPublication(input);
  }
  completeOutputPublication(
    input: Parameters<DelegationAttemptLifecycle['completeOutputPublication']>[0],
  ): DelegationTask {
    return this.lifecycle.completeOutputPublication(input);
  }
  finishAttempt(input: Parameters<DelegationAttemptLifecycle['finishAttempt']>[0]): DelegationTask {
    return this.lifecycle.finishAttempt(input);
  }
  cancelQueued(input: { runId: string; taskId: string; reason: string }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.records.tasks(input.runId).find((item) => item.id === input.taskId);
      if (!task || !['queued', 'blocked'].includes(task.state) || task.attempts.length)
        throw new Error('Only an unlaunched queued task can be cancelled.');
      task.state = 'cancelled';
      task.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId);
      if (!run) throw new Error('Delegation task run does not exist.');
      this.store.append(
        run,
        'delegation.task-cancelled',
        'Queued delegation task cancelled without launch.',
        { taskId: task.id, reason: text(input.reason, 'Cancellation reason', 1000) },
      );
      return task;
    });
  }
  blockUnreachable(input: { runId: string }): DelegationTask[] {
    return this.store.transaction(() => {
      const tasks = this.records.tasks(input.runId),
        changed: DelegationTask[] = [];
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const task of tasks) {
          if (
            !['queued', 'blocked'].includes(task.state) ||
            task.blockedReason ||
            task.attempts.length
          )
            continue;
          const assignment = this.assignment(input.runId, task);
          const predecessor =
            assignment.role !== 'main-synthesis' &&
            task.dependencies.some((id) => {
              const dependency = tasks.find((item) => item.id === id);
              return (
                dependency?.state === 'failed' ||
                dependency?.state === 'cancelled' ||
                dependency?.state === 'cleanup-unconfirmed' ||
                (dependency?.state === 'blocked' && dependency.blockedReason !== undefined)
              );
            });
          const sourceProducer = assignment.source.startsWith('output:')
            ? tasks.find((item) => item.assignmentId === assignment.source.slice('output:'.length))
            : undefined;
          const sourceProducerTerminalFailure =
            sourceProducer?.state === 'failed' ||
            sourceProducer?.state === 'cancelled' ||
            sourceProducer?.state === 'cleanup-unconfirmed' ||
            (sourceProducer?.state === 'blocked' && sourceProducer.blockedReason !== undefined);
          const absentDeclaredSource =
            assignment.role === 'main-synthesis' &&
            assignment.source.startsWith('output:') &&
            Boolean(
              sourceProducer &&
              (sourceProducerTerminalFailure ||
                (sourceProducer.state === 'completed' &&
                  !this.completedOutput({
                    runId: input.runId,
                    authorizationId: task.authorizationId,
                    producerTaskId: sourceProducer.id,
                    consumerTaskId: task.id,
                  }))),
            );
          if (!predecessor && !absentDeclaredSource) continue;
          task.state = 'blocked';
          task.blockedReason = absentDeclaredSource
            ? 'synthesis-failed-graph'
            : 'terminal-predecessor';
          task.updatedAt = now();
          this.update(task);
          changed.push(task);
          progressed = true;
        }
      }
      if (changed.length) {
        const run = this.store.runs().find((item) => item.id === input.runId);
        if (!run) throw new Error('Delegation task run does not exist.');
        this.store.append(
          run,
          'delegation.tasks-blocked',
          'Queued delegation tasks became unreachable from terminal predecessors or a missing declared synthesis source.',
          {
            tasks: changed.map((item) => ({ taskId: item.id, blockedReason: item.blockedReason })),
          },
        );
      }
      return changed;
    });
  }
  completedOutput(input: {
    runId: string;
    authorizationId: string;
    producerTaskId: string;
    consumerTaskId: string;
  }): { attemptId: string; source: DelegationSourceSnapshot } | undefined {
    const tasks = this.records.tasks(input.runId),
      producer = tasks.find((item) => item.id === input.producerTaskId),
      consumer = tasks.find((item) => item.id === input.consumerTaskId);
    if (
      !producer ||
      !consumer ||
      producer.authorizationId !== input.authorizationId ||
      consumer.authorizationId !== input.authorizationId ||
      !consumer.dependencies.includes(producer.id) ||
      producer.state !== 'completed'
    )
      return undefined;
    const attempt = producer.attempts.find(
      (item) => item.status === 'completed' && item.cleanupConfirmed && item.result?.source,
    );
    return attempt?.result?.source
      ? { attemptId: attempt.id, source: structuredClone(attempt.result.source) }
      : undefined;
  }
  reconcileOnReopen(): DelegationTask[] {
    const changed: DelegationTask[] = [];
    for (const run of this.store.runs())
      this.store.transaction(() => {
        const tasks = this.records.tasks(run.id);
        for (const task of tasks) {
          const attempt = task.attempts.find((item) =>
            ['dispatching', 'running'].includes(item.status),
          );
          if (!attempt) continue;
          const session = attempt.sessionId
            ? this.records.sessions(run.id).find((item) => item.id === attempt.sessionId)
            : undefined;
          const checksClean = (attempt.verification?.checks ?? [])
            .filter((check) => check.state !== 'queued')
            .every((check) => {
              const commandSession = this.records
                .sessions(run.id)
                .find((value) => value.id === check.sessionId);
              return (
                commandSession?.cleanupConfirmed === true &&
                ['completed', 'failed', 'interrupted'].includes(commandSession.state)
              );
            });
          if (
            checksClean &&
            session?.cleanupConfirmed === true &&
            ['completed', 'failed', 'interrupted'].includes(session.state)
          ) {
            if (attempt.runtimeRecoveryRequired) continue;
            attempt.runtimeRecoveryRequired = true;
            attempt.error =
              'Application reopened after native cleanup but before this task continuation settled.';
            attempt.updatedAt = now();
            task.updatedAt = now();
            this.update(task);
            this.store.append(run, 'delegation.task-attempt-recovery-required', attempt.error, {
              taskId: task.id,
              attemptId: attempt.id,
              sessionId: session.id,
              nativeCleanupConfirmed: true,
            });
            changed.push(task);
            continue;
          }
          attempt.status = 'cleanup-unconfirmed';
          attempt.cleanupConfirmed = false;
          attempt.error = 'Application reopened before this task attempt had confirmed cleanup.';
          attempt.updatedAt = now();
          task.state = 'cleanup-unconfirmed';
          task.updatedAt = now();
          if (session && ['dispatch-intent', 'running', 'prepared'].includes(session.state)) {
            session.state = 'cleanup-unconfirmed';
            session.cleanupConfirmed = false;
            session.error = attempt.error;
            session.updatedAt = now();
            this.sessionUpdate(session);
          }
          this.update(task);
          this.store.append(run, 'delegation.task-attempt-interrupted', attempt.error, {
            taskId: task.id,
            attemptId: attempt.id,
            sessionId: attempt.sessionId,
          });
          changed.push(task);
        }
      });
    return changed;
  }
}
