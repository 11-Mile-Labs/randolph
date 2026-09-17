import { Store } from './store.js';
import { now } from './runtime-status.js';
import { canonicalJson } from './canonical-json.js';
import { setupReconciliationProof } from './native-setup-reconciliation.js';

export type NativeOperationOwner = {
  kind: 'app-discovery' | 'run' | 'review' | 'delegation';
  id: string;
};
export type NativeOperationPurpose =
  | 'discovery'
  | 'installation-discovery'
  | 'model-turn'
  | 'command';
export type NativeOperationState =
  | 'queued'
  | 'admitted'
  | 'settled'
  | 'quarantined'
  | 'interrupted';
export type NativeOperation = {
  id: string;
  owner: NativeOperationOwner;
  runId?: string;
  sessionId?: string;
  reviewId?: string;
  checkId?: string;
  harness: 'codex' | 'grok';
  purpose: NativeOperationPurpose;
  requestedExecutable?: string;
  capacity: {
    role:
      | 'main'
      | 'worker'
      | 'main-integration'
      | 'runtime-verification'
      | 'review'
      | 'main-synthesis'
      | 'discovery'
      | 'installation-discovery'
      | 'command';
    authorizationId?: string;
    workerParallelLimit?: number;
  };
  resolvedIdentity?: { executable: string; version: string };
  generation: number;
  origin: Record<string, unknown>;
  state: NativeOperationState;
  terminalStatus?: 'completed' | 'failed' | 'interrupted';
  cleanupConfirmed?: boolean;
  cleanupEvidence?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
export type NativeOperationEvent = {
  sequence: number;
  operationId: string;
  at: string;
  type: string;
  data: Record<string, unknown>;
};
const text = (value: unknown, label: string, max = 1000): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value)
    throw new Error(`${label} is invalid.`);
  return value;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
const validOwner = new Set(['app-discovery', 'run', 'review', 'delegation']);
const validPurpose = new Set(['discovery', 'installation-discovery', 'model-turn', 'command']);

/** SQLite authority for native process intent and cleanup state. It never launches or terminates a process. */
export class NativeOperationRecords {
  constructor(private readonly store: Store) {}
  list(input: { runId?: string; owner?: NativeOperationOwner } = {}): NativeOperation[] {
    let rows: Array<{ document: string }>;
    if (input.runId)
      rows = this.store.db
        .prepare('SELECT document FROM native_operations WHERE run_id=? ORDER BY rowid')
        .all(input.runId) as Array<{ document: string }>;
    else
      rows = this.store.db
        .prepare('SELECT document FROM native_operations ORDER BY rowid')
        .all() as Array<{ document: string }>;
    return rows
      .map((row) => JSON.parse(row.document) as NativeOperation)
      .filter(
        (item) =>
          !input.owner ||
          (item.owner.kind === input.owner.kind && item.owner.id === input.owner.id),
      );
  }
  events(id: string): NativeOperationEvent[] {
    return (
      this.store.db
        .prepare(
          'SELECT sequence, document FROM native_operation_events WHERE operation_id=? ORDER BY sequence',
        )
        .all(id) as Array<{ sequence: number; document: string }>
    ).map((row) => ({ ...JSON.parse(row.document), sequence: Number(row.sequence) }));
  }
  private event(operation: NativeOperation, type: string, data: Record<string, unknown>): void {
    const event = { operationId: operation.id, at: now(), type, data };
    this.store.db
      .prepare('INSERT INTO native_operation_events(operation_id, document) VALUES (?, ?)')
      .run(operation.id, JSON.stringify(event));
    if (operation.runId) {
      const run = this.store.runs().find((item) => item.id === operation.runId);
      if (!run) throw new Error('Native operation run does not exist.');
      this.store.append(run, `native-operation.${type}`, 'Native operation state changed.', {
        operationId: operation.id,
        ...data,
      });
    }
  }
  private read(id: string): NativeOperation {
    const row = this.store.db
      .prepare('SELECT document FROM native_operations WHERE id=?')
      .get(id) as { document: string } | undefined;
    if (!row) throw new Error('Native operation is unknown.');
    return JSON.parse(row.document) as NativeOperation;
  }
  private write(value: NativeOperation): void {
    this.store.db
      .prepare('UPDATE native_operations SET document=? WHERE id=?')
      .run(JSON.stringify(value), value.id);
  }
  create(
    input: Omit<
      NativeOperation,
      | 'state'
      | 'createdAt'
      | 'updatedAt'
      | 'resolvedIdentity'
      | 'terminalStatus'
      | 'cleanupConfirmed'
      | 'cleanupEvidence'
    >,
  ): NativeOperation {
    const record: NativeOperation = {
      ...input,
      id: text(input.id, 'Native operation ID'),
      owner: {
        kind: input.owner?.kind,
        id: text(input.owner?.id, 'Native operation owner ID'),
      } as NativeOperationOwner,
      harness: input.harness,
      purpose: input.purpose,
      capacity: structuredClone(input.capacity),
      ...(input.requestedExecutable === undefined
        ? {}
        : { requestedExecutable: text(input.requestedExecutable, 'Requested executable', 2000) }),
      generation: input.generation,
      origin: structuredClone(input.origin),
      state: 'queued',
      createdAt: now(),
      updatedAt: now(),
    };
    const worker = ['worker', 'review'].includes(record.capacity?.role);
    const workerLimit = record.capacity?.workerParallelLimit;
    if (
      !validOwner.has(record.owner.kind) ||
      !validPurpose.has(record.purpose) ||
      !['codex', 'grok'].includes(record.harness) ||
      ![
        'main',
        'worker',
        'main-integration',
        'runtime-verification',
        'review',
        'main-synthesis',
        'discovery',
        'installation-discovery',
        'command',
      ].includes(record.capacity?.role) ||
      worker !== (record.capacity?.authorizationId !== undefined && workerLimit !== undefined) ||
      (!worker && (record.capacity?.authorizationId !== undefined || workerLimit !== undefined)) ||
      (worker &&
        (typeof record.capacity.authorizationId !== 'string' ||
          !record.capacity.authorizationId.trim() ||
          !Number.isSafeInteger(workerLimit) ||
          (workerLimit as number) < 1 ||
          (workerLimit as number) > 64)) ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1 ||
      !record.origin ||
      typeof record.origin !== 'object' ||
      Array.isArray(record.origin)
    )
      throw new Error('Native operation intent is invalid.');
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare('SELECT document FROM native_operations WHERE id=?')
        .get(record.id) as { document: string } | undefined;
      if (row) {
        const existing = JSON.parse(row.document) as NativeOperation;
        const immutable = {
          ...record,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          state: existing.state,
          resolvedIdentity: existing.resolvedIdentity,
          terminalStatus: existing.terminalStatus,
          cleanupConfirmed: existing.cleanupConfirmed,
          cleanupEvidence: existing.cleanupEvidence,
        };
        if (!same(existing, immutable))
          throw new Error('Native operation ID was reused with different intent.');
        return existing;
      }
      this.store.db
        .prepare(
          'INSERT INTO native_operations(id, owner_kind, owner_id, run_id, session_id, review_id, check_id, document) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.id,
          record.owner.kind,
          record.owner.id,
          record.runId ?? null,
          record.sessionId ?? null,
          record.reviewId ?? null,
          record.checkId ?? null,
          JSON.stringify(record),
        );
      this.event(record, 'queued', { generation: record.generation, purpose: record.purpose });
      return record;
    });
  }
  cancelQueued(input: {
    id: string;
    expectedGeneration: number;
    cleanupEvidence: Record<string, unknown>;
  }): NativeOperation {
    return this.store.transaction(() => {
      const item = this.read(text(input.id, 'Native operation ID'));
      if (
        item.state !== 'queued' ||
        item.generation !== input.expectedGeneration ||
        !input.cleanupEvidence ||
        !Object.keys(input.cleanupEvidence).length
      )
        throw new Error('Queued native operation cancellation is stale or invalid.');
      item.state = 'interrupted';
      item.terminalStatus = 'interrupted';
      item.cleanupConfirmed = true;
      item.cleanupEvidence = structuredClone(input.cleanupEvidence);
      item.updatedAt = now();
      this.write(item);
      this.event(item, 'interrupted', {
        generation: item.generation,
        reason: 'cancelled-before-dispatch',
      });
      return item;
    });
  }
  admit(input: {
    id: string;
    expectedGeneration: number;
    resolvedIdentity?: { executable: string; version: string };
  }): NativeOperation {
    return this.store.transaction(() => {
      const item = this.read(text(input.id, 'Native operation ID'));
      if (
        item.state === 'admitted' &&
        item.generation === input.expectedGeneration &&
        same(item.resolvedIdentity, input.resolvedIdentity)
      )
        return item;
      if (item.state !== 'queued' || item.generation !== input.expectedGeneration)
        throw new Error('Native operation admission is stale or not queued.');
      if (input.resolvedIdentity)
        item.resolvedIdentity = {
          executable: text(input.resolvedIdentity.executable, 'Resolved executable', 2000),
          version: text(input.resolvedIdentity.version, 'Resolved executable version', 200),
        };
      item.state = 'admitted';
      item.updatedAt = now();
      this.write(item);
      this.event(item, 'admitted', {
        generation: item.generation,
        resolvedIdentity: item.resolvedIdentity,
      });
      return item;
    });
  }
  resolveIdentity(input: {
    id: string;
    expectedGeneration: number;
    resolvedIdentity: { executable: string; version: string };
  }): NativeOperation {
    return this.store.transaction(() => {
      const item = this.read(text(input.id, 'Native operation ID'));
      const identity = {
        executable: text(input.resolvedIdentity?.executable, 'Resolved executable', 2000),
        version: text(input.resolvedIdentity?.version, 'Resolved executable version', 200),
      };
      if (item.state !== 'admitted' || item.generation !== input.expectedGeneration)
        throw new Error('Native operation identity resolution is stale.');
      if (item.resolvedIdentity && !same(item.resolvedIdentity, identity))
        throw new Error('Native operation identity changed.');
      item.resolvedIdentity = identity;
      item.updatedAt = now();
      this.write(item);
      this.event(item, 'resolved', { generation: item.generation, resolvedIdentity: identity });
      return item;
    });
  }
  settle(input: {
    id: string;
    expectedGeneration: number;
    status: 'completed' | 'failed' | 'interrupted';
    cleanupConfirmed: boolean;
    cleanupEvidence?: Record<string, unknown>;
  }): NativeOperation {
    return this.store.transaction(() => {
      const item = this.read(text(input.id, 'Native operation ID'));
      if (
        !['completed', 'failed', 'interrupted'].includes(input.status) ||
        typeof input.cleanupConfirmed !== 'boolean' ||
        item.generation !== input.expectedGeneration
      )
        throw new Error('Native operation settlement is invalid or stale.');
      if (item.state === 'settled' || item.state === 'quarantined') {
        if (
          item.terminalStatus === input.status &&
          item.cleanupConfirmed === input.cleanupConfirmed &&
          same(item.cleanupEvidence, input.cleanupEvidence)
        )
          return item;
        throw new Error('Native operation is already settled with different evidence.');
      }
      if (item.state !== 'admitted')
        throw new Error('Native operation must be admitted before settlement.');
      if (
        input.cleanupConfirmed &&
        (!input.cleanupEvidence || !Object.keys(input.cleanupEvidence).length)
      )
        throw new Error('Confirmed native cleanup requires evidence.');
      item.terminalStatus = input.status;
      item.cleanupConfirmed = input.cleanupConfirmed;
      if (input.cleanupEvidence) item.cleanupEvidence = structuredClone(input.cleanupEvidence);
      item.state = input.cleanupConfirmed ? 'settled' : 'quarantined';
      item.updatedAt = now();
      this.write(item);
      this.event(item, item.state, {
        generation: item.generation,
        status: item.terminalStatus,
        cleanupConfirmed: item.cleanupConfirmed,
      });
      return item;
    });
  }
  reconcileSetupCleanup(runId: string): NativeOperation[] {
    return this.store.transaction(() => {
      /* The eligibility policy reads current rows, so it is built here, inside this transaction, before any write. */
      const proof = setupReconciliationProof(this.store, runId);
      const updated: NativeOperation[] = [];
      for (const item of this.list({ runId })) {
        if (item.purpose !== 'model-turn' || item.state !== 'quarantined' || !item.sessionId)
          continue;
        /* Proved per item inside the loop: a late throw must still roll back the items written before it. */
        const evidence = proof.settlement(item);
        item.state = 'settled';
        item.terminalStatus = 'interrupted';
        item.cleanupConfirmed = true;
        item.cleanupEvidence = evidence;
        item.updatedAt = now();
        this.write(item);
        this.event(item, 'settled', { generation: item.generation, ...evidence });
        updated.push(item);
      }
      return updated;
    });
  }
  reconcileOnReopen(): NativeOperation[] {
    return this.list().flatMap((item) =>
      this.store.transaction(() => {
        const current = this.read(item.id);
        if (current.state === 'queued') {
          current.state = 'interrupted';
          current.terminalStatus = 'interrupted';
          current.cleanupConfirmed = true;
          current.cleanupEvidence = { reason: 'not-admitted-on-reopen' };
          current.updatedAt = now();
          this.write(current);
          this.event(current, 'interrupted', {
            generation: current.generation,
            reason: 'not-admitted-on-reopen',
          });
          return [current];
        }
        if (current.state === 'admitted') {
          current.state = 'quarantined';
          current.terminalStatus = 'interrupted';
          current.cleanupConfirmed = false;
          current.updatedAt = now();
          this.write(current);
          this.event(current, 'quarantined', {
            generation: current.generation,
            reason: 'admitted-on-reopen',
          });
          return [current];
        }
        return [];
      }),
    );
  }
}
