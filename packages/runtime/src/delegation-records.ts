import { randomUUID } from 'node:crypto';
import {
  delegationPlanDigest,
  parseDelegationDraft,
  parseDelegationPlan,
} from './delegation-plan.js';
import {
  activeSession,
  DelegationSessionRecords,
  digest,
  text,
  type DelegationSession,
  type ToolCallIdentity,
  type ToolReceipt,
} from './delegation-session-records.js';
import { Store } from './store.js';
import type { Run } from './contracts.js';
import { now } from './runtime-status.js';

// The native-session ledger lives in delegation-session-records.ts. These re-exports and the
// forwarding methods below keep every established delegation-records import and call site intact.
export {
  setupSessionCleanupReason,
  type DelegationSession,
  type ToolCallIdentity,
  type ToolReceipt,
} from './delegation-session-records.js';

type Row = Record<string, string | number | null>;
export type {
  PlanDisposition,
  DelegationPlanRevision,
  DelegationAuthorization,
  DelegationPresetSave,
  DelegationSourceSnapshot,
  DelegationAttemptResult,
  DelegationAttemptWorkspace,
  DelegationOutputPublication,
  DelegationPreparation,
  DelegationCheck,
  DelegationVerification,
  DelegationAttempt,
  DelegationTask,
} from './delegation-records-types.js';
import type {
  DelegationAttempt,
  DelegationAuthorization,
  DelegationPlanRevision,
  DelegationPresetSave,
  DelegationTask,
} from './delegation-records-types.js';

export class DelegationRecords {
  private readonly sessionRecords: DelegationSessionRecords;
  constructor(private readonly store: Store) {
    this.sessionRecords = new DelegationSessionRecords(store);
  }
  private run(runId: string): Run {
    const run = this.store.runs().find((candidate) => candidate.id === runId);
    if (!run) throw new Error('Delegation record run does not exist.');
    return run;
  }
  private rows<T>(
    table:
      | 'delegation_plans'
      | 'delegation_authorizations'
      | 'delegation_tasks'
      | 'delegation_sessions',
    runId: string,
  ): T[] {
    return (
      this.store.db
        .prepare(`SELECT document FROM ${table} WHERE run_id=? ORDER BY rowid`)
        .all(runId) as Row[]
    ).map((row) => JSON.parse(String(row.document)) as T);
  }
  plans(runId: string): DelegationPlanRevision[] {
    this.run(runId);
    return this.rows('delegation_plans', runId);
  }
  authorizations(runId: string): DelegationAuthorization[] {
    this.run(runId);
    return this.rows('delegation_authorizations', runId);
  }
  presetSaves(runId: string): DelegationPresetSave[] {
    this.run(runId);
    return (
      this.store.db
        .prepare('SELECT document FROM delegation_preset_saves WHERE run_id=? ORDER BY rowid')
        .all(runId) as Row[]
    ).map((row) => JSON.parse(String(row.document)) as DelegationPresetSave);
  }
  tasks(runId: string): DelegationTask[] {
    this.run(runId);
    return this.rows('delegation_tasks', runId);
  }
  sessions(runId: string): DelegationSession[] {
    return this.sessionRecords.sessions(runId);
  }
  recordPlan(
    input: Omit<
      DelegationPlanRevision,
      'id' | 'digest' | 'basisDigest' | 'createdAt' | 'disposition'
    >,
  ): DelegationPlanRevision {
    const run = this.run(input.runId),
      plan = parseDelegationDraft(input.plan),
      digestValue = delegationPlanDigest(plan),
      basisDigest = digest(input.basis);
    if (
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !['proposal', 'preset'].includes(input.source)
    )
      throw new Error('Invalid delegation plan revision.');
    text(input.requestId, 'Request identity');
    const record: DelegationPlanRevision = {
      id: randomUUID(),
      runId: input.runId,
      revision: input.revision,
      digest: digestValue,
      basis: structuredClone(input.basis),
      basisDigest,
      requestId: input.requestId,
      source: input.source,
      plan,
      createdAt: now(),
      disposition: 'draft',
    };
    this.store.transaction(() => {
      const records = this.plans(input.runId),
        latest = records.reduce((maximum, item) => Math.max(maximum, item.revision), 0);
      if (input.revision !== latest + 1)
        throw new Error('Delegation plan revisions must increase monotonically.');
      const prior = records.filter(
        (plan) => plan.disposition === 'ready' || plan.disposition === 'draft',
      );
      for (const plan of prior) {
        plan.disposition = 'superseded';
        this.store.db
          .prepare('UPDATE delegation_plans SET document=? WHERE id=?')
          .run(JSON.stringify(plan), plan.id);
      }
      this.store.db
        .prepare('INSERT INTO delegation_plans VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          record.id,
          record.runId,
          record.revision,
          record.digest,
          record.basisDigest,
          JSON.stringify(record),
        );
      this.store.append(run, 'delegation.plan-recorded', 'Delegation plan revision recorded.', {
        planId: record.id,
        revision: record.revision,
        digest: record.digest,
        basisDigest: record.basisDigest,
        source: record.source,
      });
    });
    return record;
  }
  readyPlan(input: {
    runId: string;
    planId: string;
    digest: string;
    basisDigest: string;
  }): DelegationPlanRevision {
    const run = this.run(input.runId);
    let result: DelegationPlanRevision | undefined;
    this.store.transaction(() => {
      const plan = this.plans(input.runId).find((candidate) => candidate.id === input.planId);
      if (
        !plan ||
        plan.disposition !== 'draft' ||
        plan.digest !== input.digest ||
        plan.basisDigest !== input.basisDigest
      )
        throw new Error('Delegation plan is stale or not an actionable draft.');
      parseDelegationPlan(plan.plan);
      if (
        this.sessions(input.runId).some(
          (session) => activeSession(session.state) || session.state === 'cleanup-unconfirmed',
        )
      )
        throw new Error(
          'Delegation plan cannot become ready before native session cleanup is confirmed.',
        );
      plan.disposition = 'ready';
      this.store.db
        .prepare('UPDATE delegation_plans SET document=? WHERE id=?')
        .run(JSON.stringify(plan), plan.id);
      this.store.append(
        run,
        'delegation.plan-ready',
        'Delegation plan became actionable after its native turn settled.',
        { planId: plan.id, digest: plan.digest, basisDigest: plan.basisDigest },
      );
      result = plan;
    });
    return result!;
  }
  authorize(input: {
    runId: string;
    planId: string;
    digest: string;
    basisDigest: string;
    decision: DelegationAuthorization['decision'];
    presetSaved: boolean;
  }): DelegationAuthorization {
    const run = this.run(input.runId);
    if (
      !['user', 'yolo', 'preset'].includes(input.decision) ||
      typeof input.presetSaved !== 'boolean'
    )
      throw new Error('Invalid delegation authorization.');
    let result: DelegationAuthorization | undefined;
    this.store.transaction(() => {
      const plan = this.plans(input.runId).find((candidate) => candidate.id === input.planId);
      if (
        !plan ||
        plan.disposition !== 'ready' ||
        plan.digest !== input.digest ||
        plan.basisDigest !== input.basisDigest
      )
        throw new Error(
          'Delegation authorization is stale or does not match the ready plan basis.',
        );
      parseDelegationPlan(plan.plan);
      result = {
        id: randomUUID(),
        runId: input.runId,
        planId: plan.id,
        digest: plan.digest,
        basisDigest: plan.basisDigest,
        decision: input.decision,
        presetSaved: input.presetSaved,
        createdAt: now(),
      };
      plan.disposition = 'authorized';
      this.store.db
        .prepare('UPDATE delegation_plans SET document=? WHERE id=?')
        .run(JSON.stringify(plan), plan.id);
      this.store.db
        .prepare('INSERT INTO delegation_authorizations VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          result.id,
          result.runId,
          result.planId,
          result.digest,
          result.basisDigest,
          JSON.stringify(result),
        );
      this.store.append(run, 'delegation.authorized', 'Delegation plan authorization recorded.', {
        authorizationId: result.id,
        planId: plan.id,
        digest: plan.digest,
        decision: input.decision,
        presetSaved: input.presetSaved,
      });
    });
    return result!;
  }
  recordPresetSave(input: {
    runId: string;
    planId: string;
    presetId: string;
    digest: string;
    basisDigest: string;
  }): DelegationPresetSave {
    const run = this.run(input.runId);
    text(input.presetId, 'Preset ID');
    let result: DelegationPresetSave | undefined;
    this.store.transaction(() => {
      const plan = this.plans(input.runId).find((candidate) => candidate.id === input.planId);
      if (!plan || plan.digest !== input.digest || plan.basisDigest !== input.basisDigest)
        throw new Error('Preset save does not match the retained plan revision and basis.');
      result = {
        id: randomUUID(),
        runId: input.runId,
        planId: plan.id,
        presetId: input.presetId,
        digest: plan.digest,
        basisDigest: plan.basisDigest,
        createdAt: now(),
      };
      this.store.db
        .prepare('INSERT INTO delegation_preset_saves VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          result.id,
          result.runId,
          result.planId,
          result.digest,
          result.basisDigest,
          JSON.stringify(result),
        );
      this.store.append(
        run,
        'delegation.preset-save-recorded',
        'Delegation preset-save choice recorded.',
        { presetSaveId: result.id, planId: plan.id, presetId: input.presetId, digest: plan.digest },
      );
    });
    return result!;
  }
  createTasks(input: { runId: string; authorizationId: string }): DelegationTask[] {
    const run = this.run(input.runId);
    const authorization = this.authorizations(input.runId).find(
      (item) => item.id === input.authorizationId && !item.revokedAt,
    );
    if (!authorization)
      throw new Error('Delegation tasks require an active authorization in the same run.');
    const plan = this.plans(input.runId).find((item) => item.id === authorization.planId);
    if (!plan) throw new Error('Delegation authorization lacks its retained plan.');
    if (this.tasks(input.runId).some((task) => task.authorizationId === input.authorizationId))
      throw new Error('Delegation task graph is already recorded for this authorization.');
    const taskId = (assignmentId: string): string => `${authorization.id}:${assignmentId}`;
    const records = plan.plan.assignments.map((assignment) => ({
      id: taskId(assignment.id),
      assignmentId: assignment.id,
      dependencies: assignment.dependencies.map(taskId),
      contextArtifacts: [],
      state: assignment.dependencies.length ? ('blocked' as const) : ('queued' as const),
      runId: input.runId,
      authorizationId: input.authorizationId,
      attempts: [],
      createdAt: now(),
      updatedAt: now(),
    }));
    this.store.transaction(() => {
      for (const task of records)
        this.store.db
          .prepare('INSERT INTO delegation_tasks VALUES (?, ?, ?, ?)')
          .run(task.id, task.runId, task.authorizationId, JSON.stringify(task));
      this.store.append(run, 'delegation.tasks-created', 'Authorized delegation tasks recorded.', {
        authorizationId: input.authorizationId,
        taskIds: records.map((task) => task.id),
      });
    });
    return records;
  }
  recordSession(
    input: Omit<DelegationSession, 'createdAt' | 'updatedAt' | 'native' | 'cleanupConfirmed'>,
  ): DelegationSession {
    return this.sessionRecords.recordSession(input);
  }
  bindSession(input: {
    runId: string;
    sessionId: string;
    threadId: string;
    turnId: string;
  }): DelegationSession {
    return this.sessionRecords.bindSession(input);
  }
  bindCommandSession(input: {
    runId: string;
    sessionId: string;
    commandId: string;
  }): DelegationSession {
    return this.sessionRecords.bindCommandSession(input);
  }
  finishSession(input: {
    runId: string;
    sessionId: string;
    status: 'completed' | 'failed' | 'interrupted';
    cleanupConfirmed: boolean;
    cleanupEvidence?: Record<string, unknown>;
    error?: string;
  }): DelegationSession {
    return this.sessionRecords.finishSession(input);
  }
  recordAttempt(input: {
    runId: string;
    taskId: string;
    attempt: Omit<DelegationAttempt, 'createdAt' | 'updatedAt'>;
  }): DelegationTask {
    const run = this.run(input.runId);
    let updated: DelegationTask | undefined;
    this.store.transaction(() => {
      const task = this.tasks(input.runId).find((candidate) => candidate.id === input.taskId);
      if (!task)
        throw new Error('Delegation attempt task belongs to another run or does not exist.');
      const authorization = this.authorizations(input.runId).find(
        (item) => item.id === task.authorizationId,
      );
      const plan =
        authorization && this.plans(input.runId).find((item) => item.id === authorization.planId);
      if (
        !plan ||
        ![
          'queued',
          'dispatching',
          'running',
          'completed',
          'failed',
          'interrupted',
          'cleanup-unconfirmed',
        ].includes(input.attempt.status) ||
        !Number.isSafeInteger(input.attempt.generation) ||
        input.attempt.generation !== task.attempts.length + 1 ||
        input.attempt.generation > plan.plan.limits.maxAttempts ||
        task.attempts.some((attempt) => attempt.id === input.attempt.id)
      )
        throw new Error('Delegation attempt state, generation, or configured limit is invalid.');
      const attempt = {
        ...input.attempt,
        id: text(input.attempt.id, 'Attempt ID'),
        createdAt: now(),
        updatedAt: now(),
      };
      task.attempts.push(attempt);
      task.updatedAt = now();
      this.store.db
        .prepare('UPDATE delegation_tasks SET document=? WHERE id=?')
        .run(JSON.stringify(task), task.id);
      this.store.append(
        run,
        'delegation.attempt-recorded',
        'Delegation task attempt intent recorded.',
        { taskId: task.id, attemptId: attempt.id, state: attempt.status },
      );
      updated = task;
    });
    return updated!;
  }
  recordToolReceipt(
    input: ToolCallIdentity & { runId: string; tool: string; payload: Record<string, unknown> },
    mutate: () => Record<string, unknown>,
  ): { receipt: ToolReceipt; replayed: boolean } {
    return this.sessionRecords.recordToolReceipt(input, mutate);
  }
  reconcileUnfinishedSessions(): DelegationSession[] {
    return this.sessionRecords.reconcileUnfinishedSessions();
  }
  setupSessionCleanupReason(runId: string, observedOrigin: unknown): string | null {
    return this.sessionRecords.setupSessionCleanupReason(runId, observedOrigin);
  }
  reconcileProjectSetupSessions(runId: string, observedOrigin: unknown): DelegationSession[] {
    return this.sessionRecords.reconcileProjectSetupSessions(runId, observedOrigin);
  }
}
