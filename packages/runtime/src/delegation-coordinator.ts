import { createHash, randomUUID } from 'node:crypto';
import type { HarnessAdapter, Run } from './contracts.js';
import { DelegationControls, ExecutionAdmissionClosed } from './delegation-control.js';
import { DelegationIntegrationStage } from './delegation-integration-stage.js';
import { DelegationNative } from './delegation-native.js';
import { DelegationRecords, type DelegationTask } from './delegation-records.js';
import { DelegationSources } from './delegation-sources.js';
import { DelegationTaskRunner } from './delegation-task-runner.js';
import { terminal } from './delegation-task-state.js';
import { DelegationTasks } from './delegation-tasks.js';
import { DelegationVerificationExecutor } from './delegation-verification.js';
import { NativeAdmission } from './native-admission.js';
import { Store } from './store.js';
import type { WorkspaceLeasePort } from './workspace-leases.js';

class ClosedAdmission extends ExecutionAdmissionClosed {}

/** Explicitly driven task graph. Construction and reopen never schedule execution. */
export class DelegationCoordinator {
  private readonly records: DelegationRecords;
  private readonly tasks: DelegationTasks;
  private readonly sources: DelegationSources;
  private readonly integration: DelegationIntegrationStage;
  private readonly native: DelegationNative;
  private readonly verification: DelegationVerificationExecutor;
  private readonly runner: DelegationTaskRunner;
  constructor(
    private readonly store: Store,
    private readonly controls: DelegationControls,
    private readonly admission: NativeAdmission,
    private readonly leases: WorkspaceLeasePort,
    adapterFor: (harness: 'codex' | 'grok') => HarnessAdapter,
  ) {
    this.records = new DelegationRecords(store);
    this.tasks = new DelegationTasks(store);
    this.sources = new DelegationSources(store, (input) => {
      const output = this.tasks.completedOutput(input);
      if (!output) throw new Error('Task source output is unavailable.');
      return output;
    });
    this.integration = new DelegationIntegrationStage(store, leases, undefined, controls);
    this.native = new DelegationNative(store, controls, admission, leases, adapterFor);
    this.verification = new DelegationVerificationExecutor(
      store,
      controls,
      admission,
      leases,
      adapterFor,
    );
    this.runner = new DelegationTaskRunner({
      store,
      controls,
      leases,
      records: this.records,
      tasks: this.tasks,
      sources: this.sources,
      integration: this.integration,
      native: this.native,
      verification: this.verification,
    });
  }
  private context(run: Run): Record<string, unknown> {
    const messages = run.recoveryMessages
      ? [
          ...run.recoveryMessages,
          ...this.store
            .messages(run.conversationId)
            .filter(
              (message) =>
                message.runId === run.id &&
                message.role === 'assistant' &&
                !message.id.startsWith(`${run.id}:recovery:`),
            )
            .map(({ role, text }) => ({ role, text })),
        ]
      : this.store.messages(run.conversationId).map(({ role, text }) => ({ role, text }));
    return {
      projectContext: run.projectContext,
      memory: run.memory,
      messages,
      harness: run.harness,
      executable: run.executable,
      executableVersion: run.executableVersion,
      model: run.model,
      effort: run.effort,
      enabledHarnessRoutes: run.enabledHarnessRoutes,
      harnessAuthorizationRevision: run.harnessAuthorizationRevision,
    };
  }
  private claim(runId: string, expectedGeneration: number): string {
    return this.store.transaction(() => {
      const control = this.controls.read(runId),
        run = this.store.runs().find((value) => value.id === runId);
      const plan = this.records.plans(runId).at(-1),
        authorization = this.records
          .authorizations(runId)
          .find((value) => value.id === control?.authorizationId && !value.revokedAt);
      if (
        !run ||
        !control ||
        control.generation !== expectedGeneration ||
        control.desired !== 'running' ||
        control.recoveryRequired ||
        control.coordinator?.active ||
        !plan ||
        plan.disposition !== 'authorized' ||
        authorization?.planId !== plan.id ||
        authorization.digest !== plan.digest ||
        authorization.basisDigest !== plan.basisDigest ||
        run.cleanupUnconfirmed ||
        this.records.sessions(runId).some((value) => value.state === 'cleanup-unconfirmed')
      )
        throw new Error('Coordinator admission is stale, already claimed, or requires recovery.');
      const context = control.coordinator?.context ?? this.context(run);
      if (
        createHash('sha256').update(JSON.stringify(context)).digest('hex') !==
        plan.basis.contextDigest
      )
        throw new Error('Coordinator context does not match its authorized retained basis.');
      if (Buffer.byteLength(JSON.stringify(context)) > 128 * 1024)
        throw new Error('Retained delegation context exceeds the supported input bound.');
      const id = randomUUID();
      control.coordinator = { id, active: true, context };
      this.store.db
        .prepare('UPDATE delegation_controls SET document=? WHERE run_id=?')
        .run(JSON.stringify(control), runId);
      this.store.append(
        run,
        'delegation.coordinator-claimed',
        'Task graph coordinator claimed without changing native selection or delivery authority.',
        { claim: id },
      );
      return id;
    });
  }
  private own(runId: string, claim: string): void {
    const value = this.controls.read(runId)?.coordinator;
    if (!value?.active || value.id !== claim) throw new Error('Coordinator ownership is stale.');
  }

  async drive(input: {
    runId: string;
    expectedGeneration: number;
    signal: AbortSignal;
  }): Promise<DelegationTask[]> {
    const runId = input.runId,
      signal = input.signal,
      claim = this.claim(runId, input.expectedGeneration),
      active = new Map<string, Promise<void>>();
    const attempted = new Map<string, number>();
    const claimGuard = (): number => {
      this.own(runId, claim);
      const control = this.controls.tick(runId);
      if (signal.aborted || control.desired !== 'running' || control.recoveryRequired)
        throw new ClosedAdmission('Coordinator task is paused, stopped, or requires recovery.');
      return control.generation;
    };
    try {
      for (;;) {
        this.own(runId, claim);
        const control = this.controls.tick(runId);
        if (signal.aborted && control.desired !== 'stopped')
          this.controls.command(runId, control.revision, 'stop');
        if (this.controls.read(runId)!.desired === 'stopped') {
          for (const task of this.records.tasks(runId))
            if (!task.attempts.length && !terminal(task))
              this.tasks.cancelQueued({
                runId,
                taskId: task.id,
                reason: 'The authorized graph was stopped before task launch.',
              });
        }
        this.tasks.blockUnreachable({ runId });
        const current = this.controls.read(runId)!;
        if (current.desired === 'running' && !current.recoveryRequired) {
          const tasks = this.records.tasks(runId),
            plan = this.records.plans(runId).at(-1)!;
          for (const task of tasks) {
            if (
              terminal(task) ||
              active.has(task.id) ||
              attempted.get(task.id) === current.generation
            )
              continue;
            const assignment = plan.plan.assignments.find(
              (value) => value.id === task.assignmentId,
            )!;
            const ready =
              task.attempts.length ||
              (assignment.role === 'main-synthesis'
                ? tasks
                    .filter((value) => value.id !== task.id)
                    .every((value) => terminal(value) && value.state !== 'cleanup-unconfirmed')
                : task.dependencies.every(
                    (id) => tasks.find((value) => value.id === id)?.state === 'completed',
                  ));
            if (!ready) continue;
            const prior = task.attempts.at(-1);
            if (
              prior?.controlGeneration !== undefined &&
              prior.controlGeneration !== current.generation &&
              this.records.sessions(runId).find((value) => value.id === prior.sessionId)?.state ===
                'prepared' &&
              current.activities.some((value) => value.state === 'active')
            )
              continue;
            attempted.set(task.id, current.generation);
            const execution = this.runner.run({
              runId,
              taskId: task.id,
              assignment,
              signal,
              current: claimGuard,
            });
            active.set(task.id, execution);
          }
        }
        if (!active.size) break;
        await Promise.race(
          [...active.entries()].map(async ([id, promise]) => {
            await promise;
            active.delete(id);
          }),
        );
        this.admission.queue.drain();
      }
      return this.records.tasks(runId);
    } finally {
      await Promise.allSettled(active.values());
      this.store.transaction(() => {
        this.own(runId, claim);
        const control = this.controls.read(runId)!;
        control.coordinator!.active = false;
        this.store.db
          .prepare('UPDATE delegation_controls SET document=? WHERE run_id=?')
          .run(JSON.stringify(control), runId);
      });
    }
  }
}
