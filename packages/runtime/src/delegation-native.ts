import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { AdapterEvent, HarnessAdapter } from './contracts.js';
import { AdapterRunFailure } from './contracts.js';
import { DelegationControls, type ExecutionActivity } from './delegation-control.js';
import { DelegationRecords } from './delegation-records.js';
import { DelegationTasks } from './delegation-tasks.js';
import { DelegationIntegrationStage } from './delegation-integration-stage.js';
import { NativeAdmission } from './native-admission.js';
import type { CapacityQueueReason } from './session-capacity.js';
import { Store } from './store.js';
import { assertWorkspaceIdentity } from './workspace-identity.js';
import type { WorkspaceLeasePort } from './workspace-leases.js';
import { captureGitTree } from './git-review.js';

export type DelegationNativeInput = { runId: string; taskId: string; attemptId: string; sessionId: string; expectedGeneration: number; workspaceLease: { reservationId: string; generation: number }; messages: Array<{ role: 'user' | 'assistant'; text: string }>; signal: AbortSignal };
export type DelegationNativeResult = { status: 'completed' | 'failed' | 'interrupted' | 'pending'; cleanupConfirmed: boolean; summary: string; truncated: boolean; error?: string };

/** Executes one prepared authorized attempt. Task success is recorded only after later output validation. */
export class DelegationNative {
  private readonly records: DelegationRecords;
  private readonly tasks: DelegationTasks;
  constructor(private readonly store: Store, private readonly controls: DelegationControls, private readonly admission: NativeAdmission, private readonly workspaceLeases: WorkspaceLeasePort, private readonly adapterFor: (harness: 'codex' | 'grok') => HarnessAdapter) {
    this.records = new DelegationRecords(store); this.tasks = new DelegationTasks(store);
  }

  async run(request: DelegationNativeInput): Promise<DelegationNativeResult> {
    const input: DelegationNativeInput = { runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, sessionId: request.sessionId, expectedGeneration: request.expectedGeneration, workspaceLease: { ...request.workspaceLease }, messages: structuredClone(request.messages), signal: request.signal };
    const task = this.tasks.assertAdmission(input), attempt = task.attempts.find(item => item.id === input.attemptId)!;
    const plan = this.records.plans(input.runId).at(-1)!;
    const assignment = plan.plan.assignments.find(item => item.id === task.assignmentId)!;
    const session = this.records.sessions(input.runId).find(item => item.id === input.sessionId);
    const run = this.store.runs().find(item => item.id === input.runId)!;
    if (!session || session.id !== attempt.sessionId || session.state !== 'prepared' || !attempt.workspace || !attempt.source) throw new Error('Native execution requires the exact prepared attempt session and workspace.');
    if (assignment.role === 'runtime-verification') throw new Error('Runtime verification requires its command executor, not a model turn.');
    if (['main-integration', 'main-synthesis'].includes(assignment.role) && (assignment.harness !== run.harness || assignment.executable !== run.executable || assignment.executableVersion !== run.executableVersion || assignment.model !== run.model || assignment.effort !== run.effort)) throw new Error('A main-agent phase must preserve the selected main identity.');
    if (!run.enabledHarnessRoutes?.some(route => route.harness === assignment.harness && route.executable === assignment.executable)) throw new Error('This exact native route was not enabled for the run.');
    if (!input.messages.length || input.messages.length > 200 || Buffer.byteLength(JSON.stringify(input.messages)) > 256 * 1024 || input.messages.some(message => !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string')) throw new Error('Native task context must be a bounded application-owned message list.');
    const claim = randomUUID();
    this.store.transaction(() => {
      const current = this.records.sessions(input.runId).find(value => value.id === session.id);
      if (!current || current.state !== 'prepared' || current.admissionClaim) throw new Error('This native session is already claimed or no longer prepared.');
      current.admissionClaim = claim;
      this.store.db.prepare('UPDATE delegation_sessions SET document=? WHERE id=?').run(JSON.stringify(current), current.id);
      this.store.append(run, 'delegation.native-admission-claimed', 'Exact native session admission claimed before asynchronous work.', { taskId: task.id, attemptId: attempt.id, sessionId: session.id, claim });
    });
    const assertClaim = (): void => {
      if (this.records.sessions(input.runId).find(value => value.id === session.id)?.admissionClaim !== claim) throw new Error('Native admission claim is no longer owned by this executor.');
    };
    const workspace = attempt.workspace;
    const controller = new AbortController();
    const onAbort = (): void => { controller.abort(); this.admission.queue.drain(); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) controller.abort();
    let activity: ExecutionActivity | undefined;
    let turnDispatched = false;
    let acceptingEvents = false;
    let cleanupConfirmed = true;
    let cleanupEvidence: Record<string, unknown> = { dispatch: 'not-invoked' };
    let status: DelegationNativeResult['status'] = 'failed';
    let summary = '', truncated = false, error: string | undefined;
    const audit = (type: string, text: string, data: Record<string, unknown> = {}): void => { this.store.append(run, type, text, { taskId: task.id, attemptId: attempt.id, sessionId: session.id, ...data }); };
    const guard = (): void => {
      assertClaim();
      if (controller.signal.aborted) throw new Error('Native task admission was cancelled.');
      this.tasks.assertAdmission(input);
      const ownership = this.workspaceLeases.snapshot().find(value => value.reservationId === input.workspaceLease.reservationId);
      if (!ownership || ownership.reservationId !== attempt.id || ownership.generation !== input.workspaceLease.generation || ownership.runId !== run.id || ownership.state !== 'active' || ownership.workspace !== workspace.path || ownership.identity?.device !== workspace.identity.device || ownership.identity.inode !== workspace.identity.inode) throw new Error('Native task workspace ownership is absent, stale, or quarantined.');
      assertWorkspaceIdentity(workspace.path, workspace.identity);
    };
    const finishActivity = (): void => {
      if (!activity) return;
      this.controls.finish(input.runId, activity.token, { confirmed: cleanupConfirmed, ...(cleanupConfirmed ? { evidence: cleanupEvidence } : {}) }); activity = undefined;
    };
    const timer = setInterval(() => {
      try {
        const control = this.controls.tick(input.runId);
        const authorization = this.records.authorizations(input.runId).find(value => value.id === task.authorizationId);
        if (control.desired === 'stopped' || control.recoveryRequired || !authorization || authorization.revokedAt || this.records.plans(input.runId).at(-1)?.id !== authorization.planId) controller.abort();
      } catch { controller.abort(); }
      this.admission.queue.drain();
    }, 1000);
    try {
      const adapter = this.adapterFor(assignment.harness);
      let inputTree: string | undefined;
      const context = (phase: 'discovery' | 'model-turn') => ({
        owner: { kind: 'delegation' as const, id: attempt.id }, runId: input.runId, sessionId: session.id,
        generation: input.expectedGeneration, role: assignment.role,
        ...((assignment.role === 'worker' || assignment.role === 'review') ? { authorizationId: task.authorizationId, workerParallelLimit: plan.plan.limits.maxParallel } : {}),
        priority: () => this.controls.read(input.runId)?.priority ?? 0,
        assertCurrent: guard,
        queued: (reason: CapacityQueueReason) => audit('delegation.native-queued', 'Delegation task is waiting for native capacity.', { reason, phase }),
        onAdmitted: () => {
          const stage = phase === 'discovery' ? 'discovery' : 'native-session';
          activity = this.controls.begin(input.runId, input.expectedGeneration, `${attempt.id}:${stage}:${randomUUID()}`, stage);
          audit(phase === 'discovery' ? 'delegation.discovery-started' : 'delegation.native-started', phase === 'discovery' ? 'Checking the exact native route before task dispatch.' : 'Native task dispatch has durable admission.', { harness: assignment.harness, executable: assignment.executable, executableVersion: assignment.executableVersion, model: assignment.model, effort: assignment.effort, activityToken: activity.token });
          // A newly charged model activity can exhaust the active budget before
          // the final service guard. It remains prepared and requires Resume.
          if (phase === 'model-turn') {
            if (!inputTree || captureGitTree(workspace.path, this.store.runDirectory(run)) !== inputTree) throw new Error('Prepared task source changed while native admission was pending.');
            this.controls.tick(input.runId);
          }
        },
      });
      let info: Awaited<ReturnType<HarnessAdapter['discover']>>;
      try {
        info = await this.admission.perform(assignment.harness, context('discovery'), 'discovery', assignment.executable, controller.signal,
          signal => adapter.discover(assignment.executable, signal), value => {
            cleanupConfirmed = value.cleanupVerified === true;
            cleanupEvidence = { discoveryCleanupVerified: cleanupConfirmed };
            return { status: value.available ? 'completed' : 'failed', confirmed: cleanupConfirmed, evidence: cleanupEvidence, ...(value.executable && value.version ? { identity: { executable: value.executable, version: value.version } } : {}) };
          });
      } catch (cause) {
        cleanupConfirmed = cause instanceof AdapterRunFailure;
        cleanupEvidence = cause instanceof AdapterRunFailure ? cause.cleanupEvidence : { reason: 'discovery-failure-without-cleanup-evidence' };
        throw cause;
      } finally { finishActivity(); }
      audit('delegation.discovery-finished', 'Native route discovery settled without a model turn.', { cleanupConfirmed });
      if (!cleanupConfirmed) throw new Error('Native discovery cleanup could not be confirmed.');
      guard();
      if (!info.available || !info.authenticated || info.executable !== assignment.executable || info.version !== assignment.executableVersion || !info.models.some(model => model.id === assignment.model && model.efforts.includes(assignment.effort)) || !info.executionModes?.includes(assignment.mode)) throw new Error('The authorized native route, model, effort, or execution capability is unavailable.');
      activity = this.controls.begin(input.runId, input.expectedGeneration, `${attempt.id}:source-validation:${randomUUID()}`, 'source-preparation');
      try {
        inputTree = assignment.role === 'main-integration' ? new DelegationIntegrationStage(this.store, this.workspaceLeases).candidate(input).treeOid : attempt.source.treeOid;
        if (captureGitTree(workspace.path, this.store.runDirectory(run)) !== inputTree) throw new Error('Prepared task source changed while native admission was pending.');
        this.controls.tick(input.runId); guard();
      } finally { finishActivity(); }
      let operationSignal: AbortSignal | undefined;
      const onEvent = (event: AdapterEvent): void => {
        if (!acceptingEvents || operationSignal?.aborted) return;
        assertClaim();
        if (event.type === 'session.turn-started') {
          const threadId = event.data?.threadId, turnId = event.data?.turnId;
          if (typeof threadId !== 'string' || typeof turnId !== 'string') throw new Error('Native task did not supply its thread and turn identity.');
          this.tasks.bindAttempt({ ...input, threadId, turnId });
        }
        if (controller.signal.aborted) return;
        if (event.type === 'message.delta' && typeof event.data?.text === 'string') {
          const remaining = Math.max(0, 16_000 - Buffer.byteLength(summary));
          const bytes = Buffer.from(event.data.text);
          if (bytes.length > remaining) truncated = true;
          summary += new StringDecoder('utf8').write(bytes.subarray(0, remaining));
        }
        if (event.type !== 'message.delta') audit('delegation.native-activity', event.summary.slice(0, 1000), { nativeEventType: event.type.slice(0, 160) });
      };
      let result: Awaited<ReturnType<HarnessAdapter['run']>>;
      try {
        result = await this.admission.perform(assignment.harness, context('model-turn'), 'model-turn', assignment.executable, controller.signal,
          async signal => {
            // NativeAdmission performed its final exact guard immediately before this call.
            guard(); this.tasks.dispatchAttempt(input); turnDispatched = true; operationSignal = signal; acceptingEvents = true;
            try { return await adapter.run({ workspace: workspace.path, workspaceIdentity: workspace.identity, executable: assignment.executable, executableVersion: assignment.executableVersion, model: assignment.model, effort: assignment.effort, executionMode: assignment.mode, messages: structuredClone(input.messages), signal, onEvent }); } finally { acceptingEvents = false; }
          }, value => {
            cleanupConfirmed = value.status !== 'stop-unconfirmed'; cleanupEvidence = { adapterStatus: value.status };
            return { status: value.status === 'stop-unconfirmed' ? 'failed' : value.status, confirmed: cleanupConfirmed, evidence: cleanupEvidence };
          });
      } catch (cause) {
        acceptingEvents = false;
        cleanupConfirmed = cause instanceof AdapterRunFailure;
        cleanupEvidence = cause instanceof AdapterRunFailure ? cause.cleanupEvidence : { reason: 'model-failure-without-cleanup-evidence' };
        throw cause;
      } finally { finishActivity(); }
      const bound = this.records.sessions(input.runId).find(item => item.id === session.id)?.native;
      status = result.status === 'completed' && bound?.threadId && bound.turnId ? 'completed' : result.status === 'interrupted' ? 'interrupted' : 'failed';
      if (status === 'failed') error = cleanupConfirmed ? 'Native task completed without its registered thread and turn identity.' : 'Native task cleanup could not be confirmed.';
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : 'Native task execution failed.').slice(0, 1000);
      if (cause instanceof AdapterRunFailure) { cleanupConfirmed = true; cleanupEvidence = cause.cleanupEvidence; }
      status = controller.signal.aborted && cleanupConfirmed ? 'interrupted' : 'failed';
      const control = this.controls.read(input.runId);
      const authorization = this.records.authorizations(input.runId).find(value => value.id === task.authorizationId && !value.revokedAt);
      if (!turnDispatched && cleanupConfirmed && !controller.signal.aborted && authorization?.planId === this.records.plans(input.runId).at(-1)?.id && control && !control.recoveryRequired && control.desired !== 'stopped' && (control.desired === 'paused' || control.generation !== input.expectedGeneration)) status = 'pending';
      finishActivity();
    } finally {
      acceptingEvents = false; clearInterval(timer); input.signal.removeEventListener('abort', onAbort);
      assertClaim();
      if (status !== 'pending') this.records.finishSession({ runId: input.runId, sessionId: session.id, status, cleanupConfirmed, ...(cleanupConfirmed ? { cleanupEvidence } : {}), ...(error ? { error } : {}) });
      else this.store.transaction(() => {
        assertClaim(); const current = this.records.sessions(input.runId).find(value => value.id === session.id)!;
        delete current.admissionClaim; this.store.db.prepare('UPDATE delegation_sessions SET document=? WHERE id=?').run(JSON.stringify(current), current.id);
        audit('delegation.native-admission-pending', 'Native cleanup settled; prepared task awaits explicit current admission.');
      });
    }
    return { status, cleanupConfirmed, summary, truncated, ...(error ? { error } : {}) };
  }
}
