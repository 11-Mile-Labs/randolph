import type { DelegationControl } from './delegation-control.js';
import { DelegationControls } from './delegation-control.js';
import type { WorkspaceIdentity } from './contracts.js';
import type { DelegationAssignment } from './delegation-plan.js';
import {
  DelegationRecords,
  type DelegationAttempt,
  type DelegationAttemptResult,
  type DelegationAttemptWorkspace,
  type DelegationSession,
  type DelegationSourceSnapshot,
  type DelegationTask,
} from './delegation-records.js';
import { Store } from './store.js';
import { now } from './runtime-status.js';

type SessionIntent = Omit<
  DelegationSession,
  | 'runId'
  | 'taskId'
  | 'state'
  | 'createdAt'
  | 'updatedAt'
  | 'native'
  | 'cleanupConfirmed'
  | 'cleanupEvidence'
  | 'error'
>;
type FinishStatus = 'completed' | 'failed' | 'interrupted';
const terminal = (task: DelegationTask): boolean =>
  ['completed', 'failed', 'cancelled', 'cleanup-unconfirmed'].includes(task.state) ||
  (task.state === 'blocked' && task.blockedReason !== undefined);
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
const resultText = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > 16 * 1024 ||
    Array.from(value).some(
      (character) =>
        character === '\0' ||
        (character.charCodeAt(0) < 32 && character !== '\n' && character !== '\t'),
    )
  )
    throw new Error(`${label} must be bounded native result text.`);
  return value;
};
const uniqueTexts = (value: unknown, label: string, maximum = 32): string[] => {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length)
    throw new Error(`${label} must be a bounded unique list.`);
  return value.map((item) => text(item, label));
};
const record = (value: unknown, label: string, maximum = 64 * 1024): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  let clone: Record<string, unknown>;
  try {
    clone = structuredClone(value as Record<string, unknown>);
  } catch {
    throw new Error(`${label} must contain cloneable data.`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(clone);
  } catch {
    throw new Error(`${label} must be serializable.`);
  }
  if (Buffer.byteLength(encoded, 'utf8') > maximum)
    throw new Error(`${label} exceeds its retained size limit.`);
  return clone;
};
const snapshot = (
  value: DelegationSourceSnapshot,
  label: string,
  producerTaskId?: string,
): DelegationSourceSnapshot => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a source snapshot.`);
  const result: DelegationSourceSnapshot = {
    checkpointDirectory: text(value.checkpointDirectory, `${label} checkpoint directory`, 2000),
    checkpointDigest: text(value.checkpointDigest, `${label} checkpoint digest`, 200),
    treeOid: text(value.treeOid, `${label} tree OID`, 200),
  };
  if (
    producerTaskId !== undefined &&
    value.producerTaskId !== undefined &&
    value.producerTaskId !== producerTaskId
  )
    throw new Error(`${label} producer task ID conflicts with the retained task.`);
  const producer = producerTaskId ?? value.producerTaskId;
  if (producer !== undefined) result.producerTaskId = text(producer, `${label} producer task ID`);
  return result;
};
const workspace = (value: DelegationAttemptWorkspace): DelegationAttemptWorkspace => {
  const identity = value?.identity as WorkspaceIdentity;
  if (
    !identity ||
    !Number.isSafeInteger(identity.device) ||
    identity.device < 0 ||
    !Number.isSafeInteger(identity.inode) ||
    identity.inode < 0
  )
    throw new Error('Attempt workspace identity must retain a device and inode.');
  return {
    path: text(value.path, 'Attempt workspace path', 2000),
    identity: { device: identity.device, inode: identity.inode },
  };
};
const activityClosed = (control: DelegationControl): boolean =>
  control.desired !== 'running' ||
  control.recoveryRequired ||
  control.activities.some((activity) => activity.state === 'cleanup-unconfirmed');

/** Durable per-attempt transition ledger. It admits and records intent but never launches a process. */
export class DelegationAttemptLifecycle {
  private readonly records: DelegationRecords;
  private readonly controls: DelegationControls;
  constructor(private readonly store: Store) {
    this.records = new DelegationRecords(store);
    this.controls = new DelegationControls(store);
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
  private retained(
    runId: string,
    taskId: string,
  ): { task: DelegationTask; assignment: DelegationAssignment; control: DelegationControl } {
    const task = this.records.tasks(runId).find((item) => item.id === taskId);
    if (!task) throw new Error('Delegation task belongs to another run or does not exist.');
    const authorization = this.records
      .authorizations(runId)
      .find((item) => item.id === task.authorizationId && !item.revokedAt);
    const plan = authorization && this.records.plans(runId).at(-1);
    if (
      !authorization ||
      !plan ||
      plan.id !== authorization.planId ||
      plan.disposition !== 'authorized' ||
      plan.digest !== authorization.digest ||
      plan.basisDigest !== authorization.basisDigest
    )
      throw new Error('Task execution requires the current exact nonrevoked authorization.');
    const assignment = plan.plan.assignments.find((item) => item.id === task.assignmentId);
    const control = this.controls.read(runId);
    if (
      !assignment ||
      !control ||
      control.authorizationId !== authorization.id ||
      this.records.sessions(runId).some((session) => session.state === 'cleanup-unconfirmed')
    )
      throw new Error('Task execution admission is closed.');
    const run = this.store.runs().find((item) => item.id === runId);
    if (!run || run.cleanupUnconfirmed)
      throw new Error('Task execution is blocked by unconfirmed cleanup.');
    return { task, assignment, control };
  }
  private dispatchAdmission(input: { runId: string; taskId: string; expectedGeneration: number }): {
    task: DelegationTask;
    assignment: DelegationAssignment;
    control: DelegationControl;
  } {
    const retained = this.retained(input.runId, input.taskId);
    if (
      activityClosed(retained.control) ||
      retained.control.generation !== input.expectedGeneration
    )
      throw new Error('Task dispatch admission is stale or closed.');
    return retained;
  }
  private sessionRole(assignment: DelegationAssignment): DelegationSession['role'] {
    if (assignment.role === 'runtime-verification') return 'verification';
    return assignment.role === 'main-integration' || assignment.role === 'main-synthesis'
      ? 'main'
      : 'worker';
  }
  private dependenciesReady(task: DelegationTask, tasks: DelegationTask[]): boolean {
    return task.dependencies.every(
      (id) => tasks.find((item) => item.id === id)?.state === 'completed',
    );
  }
  private synthesisReady(task: DelegationTask, tasks: DelegationTask[]): boolean {
    return tasks
      .filter((item) => item.id !== task.id)
      .every(
        (item) =>
          terminal(item) &&
          item.state !== 'cleanup-unconfirmed' &&
          item.attempts.every((attempt) => attempt.cleanupConfirmed === true),
      );
  }
  private validateIntent(intent: SessionIntent, assignment: DelegationAssignment): SessionIntent {
    if (
      intent.role !== this.sessionRole(assignment) ||
      intent.harness !== assignment.harness ||
      intent.executable !== assignment.executable ||
      intent.executableVersion !== assignment.executableVersion ||
      intent.model !== assignment.model ||
      intent.effort !== assignment.effort ||
      intent.allowedTools.length
    )
      throw new Error('Task session does not retain the exact frozen assignment identity.');
    return {
      ...intent,
      id: text(intent.id, 'Task session ID'),
      allowedTools: [],
      origin: record(intent.origin, 'Task execution origin'),
      harness: intent.harness,
      executable: intent.executable,
      executableVersion: intent.executableVersion,
      model: intent.model,
      effort: intent.effort,
      role: intent.role,
    };
  }
  assertAdmission(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedGeneration: number;
  }): DelegationTask {
    const { task, control } = this.dispatchAdmission(input);
    const attempt = task.attempts.find((item) => item.id === input.attemptId);
    if (
      !attempt ||
      !['dispatching', 'running'].includes(attempt.status) ||
      attempt.runtimeRecoveryRequired ||
      attempt.controlGeneration !== input.expectedGeneration ||
      control.generation !== input.expectedGeneration
    )
      throw new Error('Task attempt admission is stale.');
    return task;
  }
  assertRuntimeStage(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedGeneration: number;
  }): DelegationTask {
    return this.startContinuationAdmission(input);
  }
  beginAttempt(input: {
    runId: string;
    taskId: string;
    authorizationId: string;
    expectedGeneration: number;
    attemptId: string;
    session: SessionIntent;
  }): DelegationTask {
    return this.store.transaction(() => {
      const { task, assignment, control } = this.dispatchAdmission(input);
      if (
        input.authorizationId !== task.authorizationId ||
        control.generation !== input.expectedGeneration
      )
        throw new Error('Task authorization or control generation is stale.');
      if (
        task.attempts.length ||
        task.state === 'cancelled' ||
        task.state === 'cleanup-unconfirmed'
      )
        throw new Error('Task retries require a separately retained explicit decision.');
      const tasks = this.records.tasks(input.runId);
      const ready =
        assignment.role === 'main-synthesis'
          ? this.synthesisReady(task, tasks)
          : this.dependenciesReady(task, tasks);
      if (!ready) throw new Error('Task dependency frontier is not ready.');
      if (!['queued', 'blocked'].includes(task.state) || task.blockedReason)
        throw new Error('Task is not queueable.');
      const session = this.validateIntent(input.session, assignment);
      if (this.records.sessions(input.runId).some((item) => item.id === session.id))
        throw new Error('Task session ID already exists.');
      const attempt: DelegationAttempt = {
        id: text(input.attemptId, 'Attempt ID'),
        generation: 1,
        status: 'dispatching',
        sessionId: session.id,
        controlGeneration: control.generation,
        createdAt: now(),
        updatedAt: now(),
      };
      const sessionRecord: DelegationSession = {
        ...session,
        runId: input.runId,
        taskId: task.id,
        state: 'dispatch-intent',
        createdAt: now(),
        updatedAt: now(),
      };
      sessionRecord.state = 'prepared';
      task.attempts.push(attempt);
      task.state = 'running';
      task.updatedAt = now();
      this.store.db
        .prepare('INSERT INTO delegation_sessions VALUES (?, ?, ?, ?)')
        .run(sessionRecord.id, sessionRecord.runId, task.id, JSON.stringify(sessionRecord));
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-attempt-claimed',
        'Delegation task attempt and frozen native session were claimed before source preparation.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: sessionRecord.id,
          generation: control.generation,
        },
      );
      return task;
    });
  }
  bindPreparedAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    expectedGeneration: number;
    source: DelegationSourceSnapshot;
    contextArtifacts: string[];
    workspace: DelegationAttemptWorkspace;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.assertAdmission(input),
        assignment = this.assignment(input.runId, task);
      const attempt = task.attempts.find((item) => item.id === input.attemptId),
        session = this.records.sessions(input.runId).find((item) => item.id === input.sessionId);
      if (
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        attempt.status !== 'dispatching' ||
        attempt.source ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'prepared'
      )
        throw new Error('Task attempt cannot bind prepared source evidence.');
      const source = snapshot(input.source, 'Attempt source'),
        preparedWorkspace = workspace(input.workspace),
        artifacts = uniqueTexts(input.contextArtifacts, 'Attempt context artifacts');
      attempt.source = source;
      attempt.contextArtifacts = artifacts;
      attempt.workspace = preparedWorkspace;
      attempt.updatedAt = now();
      task.workspaceIdentity = `${preparedWorkspace.identity.device}:${preparedWorkspace.identity.inode}`;
      task.contextArtifacts = artifacts;
      task.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-attempt-prepared',
        'Delegation task source and workspace preparation bound before native dispatch.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: session.id,
          source,
          contextArtifacts: artifacts,
          workspace: preparedWorkspace,
          assignment: assignment.id,
        },
      );
      return task;
    });
  }
  readmittedPreparedAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    expectedGeneration: number;
  }): DelegationTask {
    return this.store.transaction(() => {
      const { task, control } = this.dispatchAdmission(input);
      const attempt = task.attempts.find((item) => item.id === input.attemptId),
        session = this.records.sessions(input.runId).find((item) => item.id === input.sessionId);
      if (
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        attempt.status !== 'dispatching' ||
        attempt.runtimeRecoveryRequired ||
        attempt.controlGeneration === input.expectedGeneration ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'prepared' ||
        control.activities.some((activity) => activity.state === 'active')
      )
        throw new Error(
          'Prepared task attempt cannot be readmitted under this control generation.',
        );
      attempt.controlGeneration = input.expectedGeneration;
      attempt.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-attempt-readmitted',
        'Prepared delegation task attempt was explicitly readmitted under the current control generation.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: session.id,
          generation: input.expectedGeneration,
        },
      );
      return task;
    });
  }
  beginPreparation(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    expectedGeneration: number;
    workspaceId: string;
    source: DelegationSourceSnapshot;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.assertAdmission(input),
        attempt = task.attempts.find((item) => item.id === input.attemptId),
        session = this.records.sessions(input.runId).find((item) => item.id === input.sessionId);
      if (
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'prepared' ||
        attempt.preparation?.state === 'intent'
      )
        throw new Error(
          'Task preparation intent is unfinished and requires recovery; preparation will not replay.',
        );
      const workspaceId = text(input.workspaceId, 'Preparation workspace ID');
      const retainedSource = snapshot(input.source, 'Preparation source');
      if (attempt.preparation?.state === 'completed') {
        if (
          attempt.preparation.workspaceId !== workspaceId ||
          JSON.stringify(attempt.preparation.source) !== JSON.stringify(retainedSource)
        )
          throw new Error(
            'Task preparation was already completed with different retained evidence.',
          );
        return task;
      }
      attempt.preparation = {
        state: 'intent',
        generation: input.expectedGeneration,
        workspaceId,
        source: retainedSource,
        createdAt: now(),
        updatedAt: now(),
      };
      attempt.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-preparation-intent',
        'Delegation task source preparation intent recorded before workspace restore.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: input.sessionId,
          generation: input.expectedGeneration,
          workspaceId,
          source: retainedSource,
        },
      );
      return task;
    });
  }
  completePreparation(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    expectedGeneration: number;
    workspace: DelegationAttemptWorkspace;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.assertAdmission(input),
        attempt = task.attempts.find((item) => item.id === input.attemptId),
        session = this.records.sessions(input.runId).find((item) => item.id === input.sessionId);
      if (
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'prepared' ||
        !attempt.preparation ||
        attempt.preparation.generation !== input.expectedGeneration
      )
        throw new Error('Task preparation completion requires its current retained intent.');
      const preparedWorkspace = workspace(input.workspace);
      if (attempt.preparation.state === 'completed') {
        if (JSON.stringify(attempt.preparation.workspace) !== JSON.stringify(preparedWorkspace))
          throw new Error('Task preparation was already completed with a different workspace.');
        return task;
      }
      attempt.preparation = {
        ...attempt.preparation,
        state: 'completed',
        workspace: preparedWorkspace,
        updatedAt: now(),
      };
      attempt.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-preparation-completed',
        'Delegation task source workspace preparation completed.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: input.sessionId,
          workspace: preparedWorkspace,
          source: attempt.preparation.source,
        },
      );
      return task;
    });
  }
  dispatchAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    expectedGeneration: number;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.assertAdmission(input);
      const attempt = task.attempts.find((item) => item.id === input.attemptId);
      const session = this.records
        .sessions(input.runId)
        .find((item) => item.id === input.sessionId);
      if (
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        !attempt.source ||
        !attempt.workspace ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'prepared'
      )
        throw new Error('Task attempt cannot dispatch without prepared source evidence.');
      session.state = 'dispatch-intent';
      session.updatedAt = now();
      this.sessionUpdate(session);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-attempt-dispatched',
        'Delegation task native dispatch intent recorded after admission and source preparation.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: session.id,
          generation: input.expectedGeneration,
        },
      );
      return task;
    });
  }
  bindAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    threadId: string;
    turnId: string;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.records.tasks(input.runId).find((item) => item.id === input.taskId);
      const attempt = task?.attempts.find((item) => item.id === input.attemptId);
      const session = this.records
        .sessions(input.runId)
        .find((item) => item.id === input.sessionId);
      if (
        !task ||
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        attempt.status !== 'dispatching' ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'dispatch-intent'
      )
        throw new Error('Task attempt cannot bind this session.');
      text(input.threadId, 'Native thread ID');
      text(input.turnId, 'Native turn ID');
      session.native = { threadId: input.threadId, turnId: input.turnId };
      session.state = 'running';
      session.updatedAt = now();
      attempt.status = 'running';
      attempt.updatedAt = now();
      this.sessionUpdate(session);
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-attempt-bound',
        'Delegation task attempt bound to its native turn.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: session.id,
          threadId: input.threadId,
          turnId: input.turnId,
        },
      );
      return task;
    });
  }
  private continuationAdmission(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedGeneration: number;
  }): DelegationTask {
    const { task, control } = this.retained(input.runId, input.taskId);
    const attempt = task.attempts.find((item) => item.id === input.attemptId);
    if (
      !attempt ||
      !['dispatching', 'running'].includes(attempt.status) ||
      attempt.runtimeRecoveryRequired ||
      control.generation !== input.expectedGeneration ||
      control.desired === 'stopped' ||
      control.recoveryRequired ||
      control.activities.some((activity) => activity.state === 'cleanup-unconfirmed')
    )
      throw new Error('Task continuation admission is stale or closed.');
    return task;
  }
  private startContinuationAdmission(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    expectedGeneration: number;
  }): DelegationTask {
    const task = this.continuationAdmission(input);
    const control = this.controls.read(input.runId)!;
    if (control.desired !== 'running')
      throw new Error('A new task continuation stage requires a running control.');
    return task;
  }
  beginOutputPublication(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    expectedGeneration: number;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.startContinuationAdmission(input),
        attempt = task.attempts.find((item) => item.id === input.attemptId),
        session = this.records.sessions(input.runId).find((item) => item.id === input.sessionId);
      if (
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'completed' ||
        session.cleanupConfirmed !== true
      )
        throw new Error(
          'Output publication requires this attempt’s completed session and confirmed cleanup.',
        );
      this.assertVerificationPassed(input.runId, task, attempt);
      if (attempt.outputPublication?.state === 'completed') return task;
      if (attempt.outputPublication?.state === 'intent')
        throw new Error(
          'Output publication intent is unfinished and requires recovery; capture will not replay.',
        );
      attempt.outputPublication = {
        state: 'intent',
        generation: input.expectedGeneration,
        createdAt: now(),
        updatedAt: now(),
      };
      attempt.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-output-publication-intent',
        'Delegation task output publication intent recorded before checkpoint capture.',
        { taskId: task.id, attemptId: attempt.id, sessionId: session.id },
      );
      return task;
    });
  }
  completeOutputPublication(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    expectedGeneration: number;
    source: DelegationSourceSnapshot;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.retained(input.runId, input.taskId).task,
        attempt = task.attempts.find((item) => item.id === input.attemptId),
        session = this.records.sessions(input.runId).find((item) => item.id === input.sessionId);
      if (
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        !session ||
        session.taskId !== task.id ||
        session.state !== 'completed' ||
        session.cleanupConfirmed !== true
      )
        throw new Error(
          'Output publication requires this attempt’s completed session and confirmed cleanup.',
        );
      if (
        attempt.runtimeRecoveryRequired ||
        !attempt.outputPublication ||
        attempt.outputPublication.generation !== input.expectedGeneration
      )
        throw new Error('Output publication continuation is stale or requires recovery.');
      const control = this.controls.read(input.runId);
      if (
        !control ||
        control.desired === 'stopped' ||
        control.recoveryRequired ||
        control.activities.some((activity) => activity.state === 'cleanup-unconfirmed')
      )
        throw new Error('Output publication continuation is closed.');
      this.assertVerificationPassed(input.runId, task, attempt);
      const published = snapshot(input.source, 'Output publication source', task.id);
      if (
        this.assignment(input.runId, task).role === 'runtime-verification' &&
        published.treeOid !== attempt.verification?.input.treeOid
      )
        throw new Error('Published verification tree must exactly match its checked input.');
      if (attempt.outputPublication?.state === 'completed') {
        if (JSON.stringify(attempt.outputPublication.source) !== JSON.stringify(published))
          throw new Error('Output publication was already completed with a different source.');
        return task;
      }
      if (attempt.outputPublication.state !== 'intent')
        throw new Error('Output publication completion requires its retained intent.');
      attempt.outputPublication = {
        state: 'completed',
        generation: attempt.outputPublication.generation,
        source: published,
        createdAt: attempt.outputPublication.createdAt,
        updatedAt: now(),
      };
      attempt.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-output-publication-completed',
        'Delegation task output checkpoint publication retained.',
        { taskId: task.id, attemptId: attempt.id, sessionId: session.id, source: published },
      );
      return task;
    });
  }
  finishAttempt(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    sessionId: string;
    status: FinishStatus;
    error?: string;
    result?: DelegationAttemptResult;
  }): DelegationTask {
    return this.store.transaction(() => {
      const task = this.records.tasks(input.runId).find((item) => item.id === input.taskId);
      const session = this.records
        .sessions(input.runId)
        .find((item) => item.id === input.sessionId);
      const attempt = task?.attempts.find((item) => item.id === input.attemptId);
      if (
        !task ||
        !attempt ||
        attempt.sessionId !== input.sessionId ||
        !session ||
        session.taskId !== task.id ||
        !['dispatching', 'running'].includes(attempt.status) ||
        !['completed', 'failed', 'interrupted', 'cleanup-unconfirmed'].includes(session.state) ||
        !['completed', 'failed', 'interrupted'].includes(input.status)
      )
        throw new Error('Task attempt completion does not match its active session.');
      const checkSessions = (attempt.verification?.checks ?? [])
        .filter((check) => check.state !== 'queued')
        .map((check) =>
          this.records.sessions(input.runId).find((value) => value.id === check.sessionId),
        );
      const cleanupConfirmed =
        session.cleanupConfirmed === true &&
        session.state !== 'cleanup-unconfirmed' &&
        checkSessions.every(
          (value) =>
            value?.cleanupConfirmed === true &&
            ['completed', 'failed', 'interrupted'].includes(value.state),
        );
      const cleanupEvidence = cleanupConfirmed
        ? record(session.cleanupEvidence, 'Task cleanup evidence', 16 * 1024)
        : undefined;
      if (cleanupConfirmed && input.status === 'completed' && session.state !== 'completed')
        throw new Error('A completed task requires a completed retained native session.');
      const publishable =
        input.status !== 'completed' || this.publishable(input.runId, task, attempt);
      const effectiveStatus: FinishStatus = publishable ? input.status : 'failed';
      const result =
        input.result === undefined
          ? undefined
          : this.result(input.result, effectiveStatus, task, !publishable);
      if (effectiveStatus === 'completed' && (!cleanupConfirmed || !result?.success))
        throw new Error(
          'Completed task attempts require confirmed cleanup and a successful result manifest.',
        );
      const producesSource = this.assignment(input.runId, task).producesSource === true;
      const verification = attempt.verification;
      if (
        effectiveStatus === 'completed' &&
        this.assignment(input.runId, task).role === 'runtime-verification' &&
        (!verification?.checks.length ||
          verification.checks.length !== verification.commands.length ||
          verification.checks.some(
            (check) =>
              check.state !== 'passed' ||
              check.cleanupConfirmed !== true ||
              check.observedTreeOid !== verification.input.treeOid,
          ))
      )
        throw new Error(
          'Runtime verification cannot complete before every retained check passed with confirmed cleanup and an unchanged source tree.',
        );
      if (
        result?.source &&
        this.assignment(input.runId, task).role === 'runtime-verification' &&
        result.source.treeOid !== verification?.input.treeOid
      )
        throw new Error('Verification result source must match its checked input tree.');
      if (result?.source && !producesSource)
        throw new Error('This assignment is not authorized to produce a source snapshot.');
      if (
        result?.source &&
        (!attempt.outputPublication ||
          attempt.outputPublication.state !== 'completed' ||
          JSON.stringify(attempt.outputPublication.source) !== JSON.stringify(result.source))
      )
        throw new Error(
          'Attempt result source must exactly match its completed output publication receipt.',
        );
      if (
        effectiveStatus === 'completed' &&
        producesSource &&
        (!result?.source ||
          !attempt.outputPublication ||
          attempt.outputPublication.state !== 'completed')
      )
        throw new Error(
          'A successful source-producing task requires a completed output publication and exact result source.',
        );
      attempt.status = cleanupConfirmed ? effectiveStatus : 'cleanup-unconfirmed';
      attempt.cleanupConfirmed = cleanupConfirmed;
      attempt.cleanupEvidence = cleanupEvidence;
      attempt.error = !publishable
        ? 'Task completed after its control generation became stale; output was not published.'
        : input.error === undefined
          ? undefined
          : text(input.error, 'Attempt error', 1000);
      attempt.result = result;
      attempt.updatedAt = now();
      task.state = cleanupConfirmed
        ? effectiveStatus === 'completed'
          ? 'completed'
          : 'failed'
        : 'cleanup-unconfirmed';
      task.updatedAt = now();
      this.update(task);
      const run = this.store.runs().find((item) => item.id === input.runId)!;
      this.store.append(
        run,
        'delegation.task-attempt-finished',
        'Delegation task attempt outcome recorded from its retained session cleanup receipt.',
        {
          taskId: task.id,
          attemptId: attempt.id,
          sessionId: session.id,
          state: task.state,
          cleanupConfirmed,
          ...(result?.source ? { source: result.source } : {}),
        },
      );
      return task;
    });
  }
  private assertVerificationPassed(
    runId: string,
    task: DelegationTask,
    attempt: DelegationAttempt,
  ): void {
    if (this.assignment(runId, task).role !== 'runtime-verification') return;
    const verification = attempt.verification;
    if (
      !verification?.checks.length ||
      verification.checks.length !== verification.commands.length ||
      verification.checks.some(
        (check) =>
          check.state !== 'passed' ||
          check.cleanupConfirmed !== true ||
          check.observedTreeOid !== verification.input.treeOid,
      )
    )
      throw new Error(
        'Runtime verification requires every retained check to pass before publishing a checked source.',
      );
  }
  private publishable(runId: string, task: DelegationTask, attempt: DelegationAttempt): boolean {
    try {
      const { control } = this.retained(runId, task.id);
      return (
        !attempt.runtimeRecoveryRequired &&
        control.desired !== 'stopped' &&
        !control.recoveryRequired &&
        !control.activities.some((activity) => activity.state === 'cleanup-unconfirmed')
      );
    } catch {
      return false;
    }
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
  private result(
    value: DelegationAttemptResult,
    status: FinishStatus,
    task: DelegationTask,
    stale = false,
  ): DelegationAttemptResult {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.success !== 'boolean' ||
      (!stale && value.success !== (status === 'completed'))
    )
      throw new Error('Attempt result success must match the retained task outcome.');
    const result: DelegationAttemptResult = {
      summary: resultText(value.summary, 'Attempt result summary'),
      artifacts: uniqueTexts(value.artifacts, 'Attempt result artifacts', 32),
      success: stale ? false : value.success,
    };
    if (!stale && value.source !== undefined)
      result.source = snapshot(value.source, 'Attempt result source', task.id);
    return result;
  }
}
