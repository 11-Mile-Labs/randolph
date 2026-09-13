import { randomUUID } from 'node:crypto';
import { DelegationRecords } from './delegation-records.js';
import { Store } from './store.js';

export type ExecutionStage = 'discovery' | 'native-session' | 'source-preparation' | 'checkpoint' | 'integration-preparation' | 'verification';
export type ExecutionActivity = { token: string; id: string; stage: ExecutionStage; generation: number; startedAt: number; elapsedMs: number; state: 'active' | 'settled' | 'cleanup-unconfirmed'; cleanupEvidence?: Record<string, unknown> };
export type DelegationControl = { runId: string; authorizationId: string; generation: number; desired: 'running' | 'paused' | 'stopped'; priority: number; budgetMs: number; spentMs: number; accountedAt?: number; recoveryRequired: boolean; activities: ExecutionActivity[] };
export type ControlStatus = 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'interrupted';
const open = (activity: ExecutionActivity): boolean => activity.state !== 'settled';
const boundedInteger = (value: number, min: number, max: number): boolean => Number.isSafeInteger(value) && value >= min && value <= max;

/** Durable admission and accounting authority; this class never launches or cancels processes. */
export class DelegationControls {
  private readonly records: DelegationRecords;
  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) { this.records = new DelegationRecords(store); }
  private time(): number { const value = this.clock(); if (!boundedInteger(value, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Execution clock must return a valid millisecond timestamp.'); return value; }
  read(runId: string): DelegationControl | undefined {
    const row = this.store.db.prepare('SELECT document FROM delegation_controls WHERE run_id=?').get(runId) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as DelegationControl : undefined;
  }
  private required(runId: string): DelegationControl { const value = this.read(runId); if (!value) throw new Error('Delegation control does not exist.'); return value; }
  private persist(value: DelegationControl, type: string, data: Record<string, unknown> = {}): void {
    const run = this.store.runs().find(item => item.id === value.runId); if (!run) throw new Error('Delegation control run does not exist.');
    this.store.db.prepare('INSERT INTO delegation_controls VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET document=excluded.document').run(value.runId, value.authorizationId, JSON.stringify(value));
    this.store.append(run, `delegation.control-${type}`, 'Delegation execution control updated.', { authorizationId: value.authorizationId, generation: value.generation, desired: value.desired, spentMs: value.spentMs, budgetMs: value.budgetMs, ...data });
  }
  private authority(value: DelegationControl): void {
    const authorization = this.records.authorizations(value.runId).find(item => item.id === value.authorizationId && !item.revokedAt);
    const plans = this.records.plans(value.runId), plan = plans.at(-1);
    if (!authorization || !plan || plan.id !== authorization.planId || plan.disposition !== 'authorized' || plan.digest !== authorization.digest || plan.basisDigest !== authorization.basisDigest) throw new Error('Execution requires the current exact nonrevoked authorization.');
    const run = this.store.runs().find(item => item.id === value.runId);
    if (run?.cleanupUnconfirmed || this.records.sessions(value.runId).some(session => session.state === 'cleanup-unconfirmed')) throw new Error('Execution is blocked by unconfirmed cleanup.');
  }
  private generation(value: DelegationControl, expected: number): void { if (value.generation !== expected) throw new Error('Execution control generation is stale.'); }
  private charge(value: DelegationControl, at: number): void {
    if (value.accountedAt !== undefined) {
      if (at < value.accountedAt) {
        value.recoveryRequired = true;
        if (value.desired !== 'stopped') value.desired = 'paused';
        value.generation += 1;
        value.activities.filter(open).forEach(activity => { activity.state = 'cleanup-unconfirmed'; });
        delete value.accountedAt;
        return;
      }
      const elapsed = at - value.accountedAt;
      value.spentMs += elapsed;
      value.activities.filter(open).forEach(activity => { activity.elapsedMs += elapsed; });
      value.accountedAt = at;
    }
    if (value.spentMs >= value.budgetMs && value.desired === 'running') { value.desired = 'paused'; value.generation += 1; }
  }
  create(runId: string, authorizationId: string): DelegationControl {
    return this.store.transaction(() => {
      if (this.read(runId)) throw new Error('Delegation control already exists.');
      const authorization = this.records.authorizations(runId).find(item => item.id === authorizationId);
      const plan = authorization && this.records.plans(runId).find(item => item.id === authorization.planId);
      if (!plan) throw new Error('Delegation control requires an existing same-run authorization.');
      const value: DelegationControl = { runId, authorizationId, generation: 1, desired: 'running', priority: 0, budgetMs: plan.plan.limits.activeMinutes * 60_000, spentMs: 0, recoveryRequired: false, activities: [] };
      this.authority(value); this.persist(value, 'created'); return value;
    });
  }
  status(value: DelegationControl): ControlStatus {
    if (value.recoveryRequired || value.activities.some(activity => activity.state === 'cleanup-unconfirmed')) return 'interrupted';
    if (value.desired === 'running') return 'running';
    if (value.desired === 'stopped') return value.activities.some(open) ? 'stopping' : 'stopped';
    return value.activities.some(open) ? 'pausing' : 'paused';
  }
  tick(runId: string): DelegationControl {
    return this.store.transaction(() => { const value = this.required(runId); this.charge(value, this.time()); this.persist(value, 'accounted'); return value; });
  }
  command(runId: string, expectedGeneration: number, action: 'pause' | 'resume' | 'stop'): DelegationControl {
    this.generation(this.required(runId), expectedGeneration);
    const accounted = this.tick(runId);
    return this.store.transaction(() => {
      const value = this.required(runId); this.generation(value, accounted.generation);
      if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Unknown execution control action.');
      if (value.desired === 'stopped') throw new Error('Stopped delegation cannot resume or change in place.');
      this.charge(value, this.time());
      if (action === 'resume') {
        this.authority(value);
        if (value.recoveryRequired || value.activities.some(open) || value.spentMs >= value.budgetMs) throw new Error('Resume requires settled cleanup and an unexhausted budget.');
        value.desired = 'running';
      } else value.desired = action === 'stop' ? 'stopped' : 'paused';
      value.generation += 1; this.persist(value, action); return value;
    });
  }
  extendBudget(runId: string, expectedGeneration: number, additionalMs: number): DelegationControl {
    return this.store.transaction(() => {
      const value = this.required(runId); this.generation(value, expectedGeneration); this.authority(value);
      if (value.desired === 'stopped' || value.recoveryRequired || !boundedInteger(additionalMs, 1, 480 * 60_000) || !Number.isSafeInteger(value.budgetMs + additionalMs)) throw new Error('Budget extension requires a positive bounded explicit decision on a recoverable run.');
      this.charge(value, this.time()); value.budgetMs += additionalMs; value.generation += 1;
      this.persist(value, 'budget-extended', { additionalMs }); return value;
    });
  }
  setPriority(runId: string, expectedGeneration: number, priority: number): DelegationControl {
    return this.store.transaction(() => {
      const value = this.required(runId); this.generation(value, expectedGeneration);
      if (!boundedInteger(priority, -100, 100) || value.desired === 'stopped') throw new Error('Priority must be a bounded integer for an unstopped run.');
      value.priority = priority; value.generation += 1; this.persist(value, 'priority', { priority }); return value;
    });
  }
  begin(runId: string, expectedGeneration: number, id: string, stage: ExecutionStage): ExecutionActivity {
    // Accounting commits separately so a denied admission cannot roll back budget exhaustion.
    this.tick(runId);
    return this.store.transaction(() => {
      const value = this.required(runId); this.generation(value, expectedGeneration); this.authority(value);
      if (value.desired !== 'running' || value.recoveryRequired || value.activities.some(activity => activity.state === 'cleanup-unconfirmed')) throw new Error('Execution admission is closed.');
      if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/u.test(id) || !['discovery', 'native-session', 'source-preparation', 'checkpoint', 'integration-preparation', 'verification'].includes(stage) || value.activities.some(activity => activity.id === id) || value.activities.length >= 10_000) throw new Error('Execution activity identity or stage is invalid or already used.');
      const at = this.time(); this.charge(value, at);
      if (value.desired !== 'running' || value.recoveryRequired) throw new Error('Execution admission expired.');
      const activity: ExecutionActivity = { token: randomUUID(), id, stage, generation: value.generation, startedAt: at, elapsedMs: 0, state: 'active' };
      value.activities.push(activity); value.accountedAt ??= at; this.persist(value, 'activity-began', { activity }); return activity;
    });
  }
  finish(runId: string, token: string, cleanup: { confirmed: boolean; evidence?: Record<string, unknown> }): DelegationControl {
    return this.store.transaction(() => {
      const value = this.required(runId), activity = value.activities.find(item => item.token === token);
      if (!activity || activity.state !== 'active') throw new Error('Activity is stale, already settled, or requires cleanup reconciliation.');
      if (typeof cleanup.confirmed !== 'boolean' || (cleanup.confirmed && (!cleanup.evidence || !Object.keys(cleanup.evidence).length || Buffer.byteLength(JSON.stringify(cleanup.evidence)) > 16_384))) throw new Error('Confirmed cleanup requires bounded retained evidence.');
      this.charge(value, this.time());
      if (activity.state === 'active') {
        activity.state = cleanup.confirmed ? 'settled' : 'cleanup-unconfirmed';
        if (cleanup.confirmed) activity.cleanupEvidence = structuredClone(cleanup.evidence);
        else { value.recoveryRequired = true; if (value.desired !== 'stopped') value.desired = 'paused'; value.generation += 1; }
      }
      if (!value.activities.some(open)) delete value.accountedAt;
      this.persist(value, 'activity-finished', { token, state: activity.state }); return value;
    });
  }
  reconcileOnReopen(): DelegationControl[] {
    const rows = this.store.db.prepare('SELECT run_id FROM delegation_controls').all() as Array<{ run_id: string }>;
    return rows.map(row => this.store.transaction(() => {
      const value = this.required(row.run_id);
      if (value.desired === 'stopped' && !value.activities.some(open)) return value;
      if (value.recoveryRequired && value.accountedAt === undefined) return value;
      this.charge(value, this.time());
      value.activities.filter(open).forEach(activity => { activity.state = 'cleanup-unconfirmed'; });
      delete value.accountedAt; value.recoveryRequired = true;
      if (value.desired !== 'stopped') value.desired = 'paused';
      value.generation += 1; this.persist(value, 'reopen-interrupted'); return value;
    }));
  }
}
