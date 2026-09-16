import { randomUUID } from 'node:crypto';
import type { HarnessAdapter } from './contracts.js';
import { AdapterRunFailure } from './contracts.js';
import { DelegationChecks } from './delegation-checks.js';
import { DelegationControls, type ExecutionActivity } from './delegation-control.js';
import { DelegationRecords } from './delegation-records.js';
import { DelegationTasks } from './delegation-tasks.js';
import { captureGitTree } from './git-workspace-snapshot.js';
import { NativeAdmission, type NativeAdmissionContext } from './native-admission.js';
import { Store } from './store.js';
import { detectVerificationCommands } from './verification.js';
import { assertWorkspaceIdentity } from './workspace-identity.js';
import type { WorkspaceLeasePort } from './workspace-leases.js';

export type DelegationVerificationInput = {
  runId: string;
  taskId: string;
  attemptId: string;
  expectedGeneration: number;
  workspaceLease: { reservationId: string; generation: number };
  signal: AbortSignal;
};
export type DelegationVerificationResult = {
  status: 'passed' | 'next-check' | 'pending' | 'failed' | 'interrupted' | 'unavailable';
  cleanupConfirmed: boolean;
  checkId?: string;
  error?: string;
};
const bounded = (value: string): string =>
  new TextDecoder().decode(Buffer.from(value).subarray(0, 16_384), { stream: true });

/** Runs at most one retained check. The coordinator must obtain fresh admission for the next check. */
export class DelegationVerificationExecutor {
  private readonly records: DelegationRecords;
  private readonly tasks: DelegationTasks;
  private readonly checks: DelegationChecks;
  constructor(
    private readonly store: Store,
    private readonly controls: DelegationControls,
    private readonly admission: NativeAdmission,
    private readonly workspaceLeases: WorkspaceLeasePort,
    private readonly adapterFor: (harness: 'codex' | 'grok') => HarnessAdapter,
  ) {
    this.records = new DelegationRecords(store);
    this.tasks = new DelegationTasks(store);
    this.checks = new DelegationChecks(store);
  }

  async runNext(request: DelegationVerificationInput): Promise<DelegationVerificationResult> {
    const input = { ...request, workspaceLease: { ...request.workspaceLease } };
    const task = this.tasks.assertRuntimeStage(input),
      attempt = task.attempts.find((item) => item.id === input.attemptId)!;
    const plan = this.records.plans(input.runId).at(-1)!;
    const assignment = plan.plan.assignments.find((item) => item.id === task.assignmentId)!;
    const run = this.store.runs().find((item) => item.id === input.runId)!;
    if (
      assignment.role !== 'runtime-verification' ||
      !attempt.workspace ||
      !attempt.source ||
      !attempt.sessionId
    )
      throw new Error('Native checks require a prepared runtime-verification attempt.');
    if (
      !run.enabledHarnessRoutes?.some(
        (route) =>
          route.harness === assignment.harness && route.executable === assignment.executable,
      )
    )
      throw new Error('This exact verification route was not enabled for the run.');
    const workspace = attempt.workspace;
    const audit = (type: string, summary: string, data: Record<string, unknown> = {}): void => {
      this.store.append(run, type, summary, { taskId: task.id, attemptId: attempt.id, ...data });
    };
    const ownership = (): void => {
      const lease = this.workspaceLeases
        .snapshot()
        .find((value) => value.reservationId === input.workspaceLease.reservationId);
      if (
        !lease ||
        lease.reservationId !== attempt.id ||
        lease.generation !== input.workspaceLease.generation ||
        lease.runId !== run.id ||
        lease.state !== 'active' ||
        lease.workspace !== workspace.path ||
        lease.identity?.device !== workspace.identity.device ||
        lease.identity.inode !== workspace.identity.inode
      )
        throw new Error('Verification workspace ownership is absent, stale, or quarantined.');
      assertWorkspaceIdentity(workspace.path, workspace.identity);
    };
    const exactTree = (): string => {
      ownership();
      return captureGitTree(workspace.path, this.store.runDirectory(run));
    };
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
      this.admission.queue.drain();
    };
    const guard = (): void => {
      if (controller.signal.aborted) throw new Error('Verification admission was cancelled.');
      this.tasks.assertRuntimeStage(input);
      ownership();
    };
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    let activity: ExecutionActivity | undefined;
    let cleanupConfirmed = true,
      cleanupEvidence: Record<string, unknown> = { dispatch: 'not-invoked' };
    let claimed: ReturnType<DelegationChecks['claimNext']> | undefined;
    let dispatched = false,
      accepting = false,
      nativeInvoked = false;
    let status: DelegationVerificationResult['status'] = 'failed';
    let truncated = false;
    let error: string | undefined,
      output = '',
      exitCode: number | null = null,
      observedTreeOid = 'unavailable';
    const settle = (): void => {
      if (!activity) return;
      this.controls.finish(run.id, activity.token, {
        confirmed: cleanupConfirmed,
        ...(cleanupConfirmed ? { evidence: cleanupEvidence } : {}),
      });
      activity = undefined;
    };
    const timer = setInterval(() => {
      try {
        const control = this.controls.tick(run.id);
        const auth = this.records
          .authorizations(run.id)
          .find((value) => value.id === task.authorizationId);
        if (
          control.desired === 'stopped' ||
          control.recoveryRequired ||
          !auth ||
          auth.revokedAt ||
          auth.planId !== this.records.plans(run.id).at(-1)?.id
        )
          cancel();
      } catch {
        cancel();
      }
      this.admission.queue.drain();
    }, 1000);
    try {
      guard();
      activity = this.controls.begin(
        run.id,
        input.expectedGeneration,
        `${attempt.id}:check-source:${randomUUID()}`,
        'verification',
      );
      if (exactTree() !== attempt.source.treeOid)
        throw new Error('Verification input no longer matches its prepared source.');
      if (!this.checks.snapshot(input)) {
        if (exactTree() !== attempt.source.treeOid)
          throw new Error('Verification input changed before manifest detection.');
        const detected = await detectVerificationCommands(workspace.path);
        guard();
        if (exactTree() !== attempt.source.treeOid)
          throw new Error('Verification input changed during manifest detection.');
        if (
          !detected.length ||
          detected.some((command) => command.unsupportedReason || !command.command)
        ) {
          status = 'unavailable';
          throw new Error(
            detected.find((command) => command.unsupportedReason)?.unsupportedReason ??
              'No supported project checks were detected.',
          );
        }
        this.checks.initialize({
          ...input,
          commands: detected.map((command) => [command.command, ...command.args]),
        });
      }
      settle();
      guard();
      if (this.checks.passed(input)) {
        status = 'passed';
        return { status, cleanupConfirmed };
      }
      // This transaction is the ownership claim. A concurrent executor cannot settle or launch it.
      claimed = this.checks.claimNext({ ...input, sessionId: randomUUID() });
      const sessionId = claimed.session.id,
        checkId = claimed.check.id;
      const context: NativeAdmissionContext = {
        owner: { kind: 'delegation', id: attempt.id },
        runId: run.id,
        sessionId,
        checkId,
        generation: input.expectedGeneration,
        role: 'runtime-verification',
        priority: () => this.controls.read(run.id)?.priority ?? 0,
        assertCurrent: guard,
        queued: (reason) =>
          audit('delegation.check-queued', 'Native project check is waiting for capacity.', {
            sessionId,
            checkId,
            reason,
          }),
      };
      const adapter = this.adapterFor(assignment.harness);
      const info = await this.admission.perform(
        assignment.harness,
        {
          ...context,
          onAdmitted: () => {
            activity = this.controls.begin(
              run.id,
              input.expectedGeneration,
              `${attempt.id}:check-discovery:${randomUUID()}`,
              'discovery',
            );
          },
        },
        'discovery',
        assignment.executable,
        controller.signal,
        (signal) => {
          nativeInvoked = true;
          cleanupConfirmed = false;
          return adapter.discover(assignment.executable, signal);
        },
        (value) => ({
          status: value.available ? 'completed' : 'failed',
          confirmed: value.cleanupVerified === true,
          evidence: { discoveryCleanupVerified: value.cleanupVerified === true },
          ...(value.executable && value.version
            ? { identity: { executable: value.executable, version: value.version } }
            : {}),
        }),
      );
      cleanupConfirmed = info.cleanupVerified === true;
      cleanupEvidence = { discoveryCleanupVerified: cleanupConfirmed };
      settle();
      if (!cleanupConfirmed)
        throw new Error('Native check discovery cleanup could not be confirmed.');
      guard();
      if (
        !info.available ||
        !info.authenticated ||
        info.executable !== assignment.executable ||
        info.version !== assignment.executableVersion ||
        !info.commandLifecycle ||
        !info.executionModes?.includes('code') ||
        !info.models.some(
          (model) => model.id === assignment.model && model.efforts.includes(assignment.effort),
        ) ||
        !adapter.runCommand
      ) {
        status = 'unavailable';
        throw new Error('The authorized harness has no verified native command lifecycle.');
      }
      const result = await this.admission.perform(
        assignment.harness,
        {
          ...context,
          onAdmitted: () => {
            activity = this.controls.begin(
              run.id,
              input.expectedGeneration,
              `${attempt.id}:check:${checkId}:${randomUUID()}`,
              'verification',
            );
            if (exactTree() !== attempt.source!.treeOid)
              throw new Error('Verification source changed while command admission was pending.');
            this.controls.tick(run.id);
            guard();
          },
        },
        'command',
        assignment.executable,
        controller.signal,
        (signal) => {
          nativeInvoked = true;
          cleanupConfirmed = false;
          accepting = true;
          return adapter.runCommand!({
            executable: assignment.executable,
            executableVersion: assignment.executableVersion,
            workspace: workspace.path,
            workspaceIdentity: workspace.identity,
            command: [...claimed!.check.argv],
            signal,
            onDispatch: (value) => {
              if (!accepting || signal.aborted || dispatched)
                throw new Error('Native command dispatch callback is late or duplicated.');
              this.controls.tick(run.id);
              guard();
              if (exactTree() !== attempt.source!.treeOid)
                throw new Error('Verification source changed before native command dispatch.');
              this.controls.tick(run.id);
              guard();
              this.checks.bindCommand({ ...input, sessionId, checkId, commandId: value.processId });
              dispatched = true;
            },
            onOutput: (value) => {
              if (accepting && typeof value === 'string') {
                truncated ||= Buffer.byteLength(output) + Buffer.byteLength(value) > 16_384;
                output = bounded(output + bounded(value));
              }
            },
          });
        },
        (value) => ({
          status: value.exitCode === 0 ? 'completed' : 'failed',
          confirmed: value.cleanupVerified === true,
          evidence: {
            commandCleanupVerified: value.cleanupVerified === true,
            exitCode: value.exitCode,
          },
        }),
      );
      accepting = false;
      cleanupConfirmed = result.cleanupVerified === true;
      cleanupEvidence = {
        commandCleanupVerified: cleanupConfirmed,
        exitCode: result.exitCode,
        commandId: dispatched
          ? this.checks.snapshot(input)?.checks.find((check) => check.id === checkId)?.commandId
          : undefined,
      };
      truncated ||= result.truncated || Buffer.byteLength(result.output || output) > 16_384;
      output = bounded(result.output || output);
      exitCode = result.exitCode;
      if (result.error) error = result.error.slice(0, 1000);
      observedTreeOid = exactTree();
      status = controller.signal.aborted
        ? 'interrupted'
        : dispatched &&
            cleanupConfirmed &&
            !error &&
            exitCode === 0 &&
            observedTreeOid === attempt.source.treeOid
          ? 'next-check'
          : 'failed';
      const current = this.controls.read(run.id);
      if (
        !dispatched &&
        cleanupConfirmed &&
        !controller.signal.aborted &&
        current &&
        !current.recoveryRequired &&
        current.desired !== 'stopped' &&
        (current.desired === 'paused' || current.generation !== input.expectedGeneration)
      )
        status = 'pending';
      if (status === 'failed' && !error)
        error = !dispatched
          ? 'Native check returned without its command identity.'
          : !cleanupConfirmed
            ? 'Native check cleanup could not be confirmed.'
            : observedTreeOid !== attempt.source.treeOid
              ? 'Native check changed its eligible input source.'
              : 'Native project check failed.';
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : 'Native project check failed.').slice(
        0,
        1000,
      );
      if (cause instanceof AdapterRunFailure) {
        cleanupConfirmed = true;
        cleanupEvidence = cause.cleanupEvidence;
      }
      if (!nativeInvoked) {
        cleanupConfirmed = true;
        cleanupEvidence = { dispatch: 'not-invoked' };
      }
      if (controller.signal.aborted) status = 'interrupted';
      const control = this.controls.read(run.id),
        auth = this.records
          .authorizations(run.id)
          .find((value) => value.id === task.authorizationId && !value.revokedAt);
      if (
        !dispatched &&
        cleanupConfirmed &&
        !controller.signal.aborted &&
        auth?.planId === this.records.plans(run.id).at(-1)?.id &&
        control &&
        !control.recoveryRequired &&
        control.desired !== 'stopped' &&
        (control.desired === 'paused' || control.generation !== input.expectedGeneration)
      )
        status = 'pending';
    } finally {
      accepting = false;
      clearInterval(timer);
      input.signal.removeEventListener('abort', cancel);
      try {
        if (claimed) {
          const identity = { ...input, sessionId: claimed.session.id, checkId: claimed.check.id };
          if (status === 'pending') {
            this.records.finishSession({
              ...identity,
              status: 'interrupted',
              cleanupConfirmed: true,
              cleanupEvidence,
            });
            this.checks.deferCheck(identity);
          } else {
            const nativeStatus =
              status === 'next-check'
                ? 'completed'
                : status === 'interrupted'
                  ? 'interrupted'
                  : 'failed';
            this.records.finishSession({
              ...identity,
              status: nativeStatus,
              cleanupConfirmed,
              ...(cleanupConfirmed ? { cleanupEvidence } : {}),
              ...(error ? { error } : {}),
            });
            if (dispatched)
              this.checks.finishCheck({
                ...identity,
                status: nativeStatus,
                exitCode,
                output,
                truncated,
                observedTreeOid,
              });
            else
              this.checks.failUndispatchedCheck({
                ...identity,
                status:
                  status === 'unavailable'
                    ? 'unavailable'
                    : status === 'interrupted'
                      ? 'interrupted'
                      : 'failed',
                error: error ?? 'Native project check was not dispatched.',
              });
          }
        }
      } finally {
        settle();
      }
    }
    if (status === 'next-check' && this.checks.passed(input)) status = 'passed';
    return {
      status,
      cleanupConfirmed,
      ...(claimed ? { checkId: claimed.check.id } : {}),
      ...(error ? { error } : {}),
    };
  }
}
