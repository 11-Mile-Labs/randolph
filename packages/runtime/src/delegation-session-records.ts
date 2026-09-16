import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.js';
import type { Conversation, Run } from './contracts.js';
import type { DelegationTask } from './delegation-records-types.js';
import { cleanupReconciliationReason } from './execution-origin.js';
import { now } from './runtime-status.js';
import { canonicalJson } from './canonical-json.js';

type Row = Record<string, string | number | null>;
export type DelegationSession = {
  admissionClaim?: string;
  id: string;
  runId: string;
  taskId?: string;
  role: 'main' | 'worker' | 'verification';
  harness: string;
  executable: string;
  executableVersion: string;
  model: string;
  effort: string;
  allowedTools: string[];
  native?: { threadId?: string; turnId?: string; sessionId?: string; commandId?: string };
  origin?: Record<string, unknown>;
  state:
    | 'prepared'
    | 'dispatch-intent'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'cleanup-unconfirmed';
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  cleanupConfirmed?: boolean;
  cleanupEvidence?: Record<string, unknown>;
  error?: string;
};
export type ToolCallIdentity = {
  sessionId: string;
  threadId: string;
  turnId: string;
  callId: string;
  requestId: string | number;
};
export type ToolReceipt = {
  identity: ToolCallIdentity;
  tool: string;
  payloadDigest: string;
  receipt: Record<string, unknown>;
  createdAt: string;
};

export const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
export const text = (value: string, label: string): string => {
  if (
    !value ||
    value.length > 500 ||
    value.trim() !== value ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`${label} must be bounded nonempty text.`);
  return value;
};
const ids = (items: string[], label: string): string[] => {
  if (!Array.isArray(items) || items.length > 32 || new Set(items).size !== items.length)
    throw new Error(`${label} must be a bounded unique list.`);
  return items.map((item) => text(item, label));
};
function boundedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(value as Record<string, unknown>);
  } catch {
    throw new Error(`${label} must contain cloneable data.`);
  }
  if (Buffer.byteLength(JSON.stringify(canonicalJson(cloned)), 'utf8') > 64 * 1024)
    throw new Error(`${label} exceeds the 64 KB limit.`);
  return cloned;
}
export const activeSession = (state: DelegationSession['state']): boolean =>
  ['prepared', 'dispatch-intent', 'running'].includes(state);
const allowedTools = new Set(['randolph_propose_delegation', 'randolph_read_tasks']);

export function setupSessionCleanupReason(input: {
  run: Run;
  conversation?: Conversation;
  sessions: DelegationSession[];
  taskCount: number;
  hasToolReceipts: boolean;
  hasControls: boolean;
  observedOrigin: unknown;
}): string | null {
  if (
    !input.conversation ||
    input.conversation.kind !== 'project-setup' ||
    input.run.executionMode !== 'read-only'
  )
    return 'Only read-only project setup sessions can use setup cleanup reconciliation.';
  if (input.hasControls)
    return 'Setup cleanup reconciliation cannot settle delegation control activity.';
  if (input.taskCount || input.hasToolReceipts)
    return 'Setup cleanup reconciliation cannot settle task or application-tool authority.';
  if (
    input.sessions.some(
      (session) => session.role !== 'main' || session.taskId || session.allowedTools.length,
    )
  )
    return 'Setup cleanup reconciliation cannot settle worker, verification, task, or tool sessions.';
  if (input.sessions.some((session) => activeSession(session.state)))
    return 'Setup cleanup reconciliation cannot settle an active native session.';
  const runReason = cleanupReconciliationReason(input.run.executionOrigin, input.observedOrigin);
  if (runReason) return runReason;
  return (
    input.sessions
      .filter((session) => session.state === 'cleanup-unconfirmed')
      .map((session) => cleanupReconciliationReason(session.origin, input.observedOrigin))
      .find((reason) => reason !== null) ?? null
  );
}

export class DelegationSessionRecords {
  constructor(private readonly store: Store) {}
  private run(runId: string): Run {
    const run = this.store.runs().find((candidate) => candidate.id === runId);
    if (!run) throw new Error('Delegation record run does not exist.');
    return run;
  }
  private rows<T>(table: 'delegation_tasks' | 'delegation_sessions', runId: string): T[] {
    return (
      this.store.db
        .prepare(`SELECT document FROM ${table} WHERE run_id=? ORDER BY rowid`)
        .all(runId) as Row[]
    ).map((row) => JSON.parse(String(row.document)) as T);
  }
  private tasks(runId: string): DelegationTask[] {
    this.run(runId);
    return this.rows('delegation_tasks', runId);
  }
  sessions(runId: string): DelegationSession[] {
    this.run(runId);
    return this.rows('delegation_sessions', runId);
  }
  recordSession(
    input: Omit<DelegationSession, 'createdAt' | 'updatedAt' | 'native' | 'cleanupConfirmed'>,
  ): DelegationSession {
    const run = this.run(input.runId);
    text(input.id, 'Application session ID');
    if (
      !['main', 'worker', 'verification'].includes(input.role) ||
      !['prepared', 'dispatch-intent'].includes(input.state) ||
      !Array.isArray(input.allowedTools) ||
      input.allowedTools.some((tool) => !allowedTools.has(tool)) ||
      (input.role !== 'main' && input.allowedTools.length)
    )
      throw new Error('Invalid delegation session.');
    if (this.sessions(input.runId).some((session) => session.id === input.id))
      throw new Error('Application session ID already exists.');
    if (input.taskId && !this.tasks(input.runId).some((task) => task.id === input.taskId))
      throw new Error('Delegation session task belongs to another run or does not exist.');
    const record: DelegationSession = {
      ...input,
      id: input.id,
      allowedTools: ids(input.allowedTools, 'Allowed application tools'),
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.transaction(() => {
      this.store.db
        .prepare('INSERT INTO delegation_sessions VALUES (?, ?, ?, ?)')
        .run(record.id, record.runId, record.taskId ?? null, JSON.stringify(record));
      this.store.append(
        run,
        'delegation.session-recorded',
        'Delegation native session intent recorded.',
        { sessionId: record.id, taskId: record.taskId, state: record.state },
      );
    });
    return record;
  }
  bindSession(input: {
    runId: string;
    sessionId: string;
    threadId: string;
    turnId: string;
  }): DelegationSession {
    const run = this.run(input.runId);
    text(input.threadId, 'Native thread ID');
    text(input.turnId, 'Native turn ID');
    let result: DelegationSession | undefined;
    this.store.transaction(() => {
      const session = this.sessions(input.runId).find(
        (candidate) => candidate.id === input.sessionId,
      );
      if (!session) throw new Error('Delegation session belongs to another run or does not exist.');
      if (session.role === 'verification' && session.taskId)
        throw new Error(
          'Delegated verification sessions require command identity, not a model turn.',
        );
      const native = { ...session.native, threadId: input.threadId, turnId: input.turnId };
      if (
        session.state === 'running' &&
        session.native?.threadId === input.threadId &&
        session.native?.turnId === input.turnId
      ) {
        result = session;
        return;
      }
      if (session.state !== 'prepared' && session.state !== 'dispatch-intent')
        throw new Error('Delegation session cannot be rebound.');
      if (session.native?.threadId || session.native?.turnId)
        throw new Error('Delegation session native identity cannot be rebound.');
      session.native = native;
      session.state = 'running';
      session.updatedAt = now();
      this.store.db
        .prepare('UPDATE delegation_sessions SET document=? WHERE id=?')
        .run(JSON.stringify(session), session.id);
      this.store.append(
        run,
        'delegation.session-bound',
        'Delegation native session bound to its registered turn.',
        { sessionId: session.id, threadId: input.threadId, turnId: input.turnId },
      );
      result = session;
    });
    return result!;
  }
  bindCommandSession(input: {
    runId: string;
    sessionId: string;
    commandId: string;
  }): DelegationSession {
    const run = this.run(input.runId);
    text(input.commandId, 'Native command ID');
    let result: DelegationSession | undefined;
    this.store.transaction(() => {
      const session = this.sessions(input.runId).find(
        (candidate) => candidate.id === input.sessionId,
      );
      if (
        !session ||
        session.role !== 'verification' ||
        session.state !== 'prepared' ||
        session.native?.commandId
      )
        throw new Error('Verification command session cannot be rebound.');
      session.native = { commandId: input.commandId };
      session.state = 'running';
      session.updatedAt = now();
      this.store.db
        .prepare('UPDATE delegation_sessions SET document=? WHERE id=?')
        .run(JSON.stringify(session), session.id);
      this.store.append(
        run,
        'delegation.command-bound',
        'Verification session bound to its native command.',
        { sessionId: session.id, commandId: input.commandId },
      );
      result = session;
    });
    return result!;
  }
  finishSession(input: {
    runId: string;
    sessionId: string;
    status: 'completed' | 'failed' | 'interrupted';
    cleanupConfirmed: boolean;
    cleanupEvidence?: Record<string, unknown>;
    error?: string;
  }): DelegationSession {
    const run = this.run(input.runId);
    if (
      !['completed', 'failed', 'interrupted'].includes(input.status) ||
      typeof input.cleanupConfirmed !== 'boolean' ||
      (input.cleanupConfirmed &&
        (!input.cleanupEvidence || !Object.keys(input.cleanupEvidence).length))
    )
      throw new Error('Invalid delegation session completion or cleanup evidence.');
    let result: DelegationSession | undefined;
    this.store.transaction(() => {
      const session = this.sessions(input.runId).find(
          (candidate) => candidate.id === input.sessionId,
        ),
        bound =
          Boolean(session?.native?.threadId && session.native.turnId) ||
          Boolean(session?.role === 'verification' && session.native?.commandId);
      if (!session || !activeSession(session.state) || (!bound && input.status === 'completed'))
        throw new Error(
          'Delegation session cannot finish without a bound active native turn or verification command and confirmed cleanup evidence.',
        );
      session.state = input.cleanupConfirmed ? input.status : 'cleanup-unconfirmed';
      session.cleanupConfirmed = input.cleanupConfirmed;
      session.cleanupEvidence = input.cleanupConfirmed
        ? boundedRecord(input.cleanupEvidence, 'Cleanup evidence')
        : undefined;
      session.error = input.error;
      session.updatedAt = now();
      this.store.db
        .prepare('UPDATE delegation_sessions SET document=? WHERE id=?')
        .run(JSON.stringify(session), session.id);
      this.store.append(
        run,
        'delegation.session-finished',
        'Delegation native session completion recorded.',
        {
          sessionId: session.id,
          state: session.state,
          cleanupConfirmed: session.cleanupConfirmed,
          ...(session.cleanupEvidence ? { cleanupEvidence: session.cleanupEvidence } : {}),
        },
      );
      result = session;
    });
    return result!;
  }
  recordToolReceipt(
    input: ToolCallIdentity & { runId: string; tool: string; payload: Record<string, unknown> },
    mutate: () => Record<string, unknown>,
  ): { receipt: ToolReceipt; replayed: boolean } {
    const run = this.run(input.runId);
    if (run.status !== 'running') throw new Error('Tool request run is not active.');
    text(input.sessionId, 'Tool session ID');
    text(input.threadId, 'Tool thread ID');
    text(input.turnId, 'Tool turn ID');
    text(input.callId, 'Tool call ID');
    text(input.tool, 'Tool name');
    if (
      (typeof input.requestId !== 'string' && typeof input.requestId !== 'number') ||
      (typeof input.requestId === 'number' && !Number.isSafeInteger(input.requestId))
    )
      throw new Error('Tool JSON-RPC request ID must be a string or safe integer.');
    const payload = boundedRecord(input.payload, 'Tool payload');
    const session = this.sessions(input.runId).find(
      (candidate) => candidate.id === input.sessionId,
    );
    if (
      !session ||
      session.role !== 'main' ||
      session.state !== 'running' ||
      session.native?.threadId !== input.threadId ||
      session.native.turnId !== input.turnId ||
      !session.allowedTools.includes(input.tool)
    )
      throw new Error(
        'Tool request does not match an active bound main session and its allowed tools.',
      );
    const fingerprint = digest({
      threadId: input.threadId,
      turnId: input.turnId,
      callId: input.callId,
      requestId: input.requestId,
      tool: input.tool,
      payload,
    });
    const requestKey = JSON.stringify(input.requestId);
    let output: { receipt: ToolReceipt; replayed: boolean } | undefined;
    this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          'SELECT document FROM delegation_tool_receipts WHERE session_id=? AND (call_id=? OR request_id=?)',
        )
        .all(input.sessionId, input.callId, requestKey) as Row[];
      if (rows.length) {
        const prior = JSON.parse(String(rows[0].document)) as ToolReceipt & { fingerprint: string };
        if (prior.fingerprint !== fingerprint)
          throw new Error(
            'Tool call or JSON-RPC request identity was reused with different content.',
          );
        output = {
          receipt: {
            identity: prior.identity,
            tool: prior.tool,
            payloadDigest: prior.payloadDigest,
            receipt: prior.receipt,
            createdAt: prior.createdAt,
          },
          replayed: true,
        };
        return;
      }
      const receipt = mutate();
      if (receipt && typeof (receipt as { then?: unknown }).then === 'function')
        throw new Error('Tool receipt mutation must be synchronous.');
      const record = {
        id: randomUUID(),
        runId: input.runId,
        sessionId: input.sessionId,
        identity: {
          sessionId: input.sessionId,
          threadId: input.threadId,
          turnId: input.turnId,
          callId: input.callId,
          requestId: input.requestId,
        },
        tool: input.tool,
        payloadDigest: digest(payload),
        receipt: boundedRecord(receipt, 'Tool receipt'),
        createdAt: now(),
        fingerprint,
      };
      this.store.db
        .prepare('INSERT INTO delegation_tool_receipts VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          record.id,
          record.runId,
          record.sessionId,
          input.callId,
          requestKey,
          fingerprint,
          JSON.stringify(record),
        );
      this.store.append(
        run,
        'delegation.tool-receipt',
        'Delegation application-tool receipt recorded.',
        {
          sessionId: input.sessionId,
          callId: input.callId,
          requestId: input.requestId,
          tool: input.tool,
          payloadDigest: record.payloadDigest,
        },
      );
      output = {
        receipt: {
          identity: record.identity,
          tool: record.tool,
          payloadDigest: record.payloadDigest,
          receipt: record.receipt,
          createdAt: record.createdAt,
        },
        replayed: false,
      };
    });
    return output!;
  }
  reconcileUnfinishedSessions(): DelegationSession[] {
    const changed: DelegationSession[] = [];
    for (const run of this.store.runs())
      this.store.transaction(() => {
        for (const session of this.sessions(run.id))
          if (['prepared', 'dispatch-intent', 'running'].includes(session.state)) {
            session.state = 'cleanup-unconfirmed';
            session.cleanupConfirmed = false;
            session.error = 'Application reopened before this session had confirmed cleanup.';
            session.updatedAt = now();
            this.store.db
              .prepare('UPDATE delegation_sessions SET document=? WHERE id=?')
              .run(JSON.stringify(session), session.id);
            this.store.append(run, 'delegation.session-interrupted', session.error, {
              sessionId: session.id,
            });
            changed.push(session);
          }
      });
    return changed;
  }
  setupSessionCleanupReason(runId: string, observedOrigin: unknown): string | null {
    const run = this.run(runId);
    const conversation = this.store
      .conversations()
      .find((candidate) => candidate.id === run.conversationId);
    return setupSessionCleanupReason({
      run,
      conversation,
      sessions: this.sessions(runId),
      taskCount: this.tasks(runId).length,
      hasToolReceipts: Boolean(
        this.store.db
          .prepare('SELECT 1 FROM delegation_tool_receipts WHERE run_id=? LIMIT 1')
          .get(runId),
      ),
      hasControls: Boolean(
        this.store.db
          .prepare('SELECT 1 FROM delegation_controls WHERE run_id=? LIMIT 1')
          .get(runId),
      ),
      observedOrigin,
    });
  }
  reconcileProjectSetupSessions(runId: string, observedOrigin: unknown): DelegationSession[] {
    const run = this.run(runId);
    let result: DelegationSession[] = [];
    this.store.transaction(() => {
      const reason = this.setupSessionCleanupReason(runId, observedOrigin);
      if (reason) throw new Error(reason);
      const sessions = this.sessions(runId);
      const unsettled = sessions.filter((session) => session.state === 'cleanup-unconfirmed');
      for (const session of unsettled) {
        session.state = 'interrupted';
        session.cleanupConfirmed = true;
        session.cleanupEvidence = { reconciliation: 'later-boot' };
        session.error =
          'Previous setup inspection session ended with an earlier boot on this Mac. No work has been restarted.';
        session.updatedAt = now();
        this.store.db
          .prepare('UPDATE delegation_sessions SET document=? WHERE id=?')
          .run(JSON.stringify(session), session.id);
        this.store.append(
          run,
          'delegation.session-cleanup-reconciled',
          'Setup native session cleanup reconciled after a later boot.',
          { sessionId: session.id, recordedOrigin: session.origin, observedOrigin },
        );
      }
      result = unsettled;
    });
    return result;
  }
}
