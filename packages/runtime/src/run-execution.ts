import type { HarnessId } from './contracts.js';
import { DelegationControls } from './delegation-control.js';
import { DelegationRecords } from './delegation-records.js';
import type { NativeAdmission } from './native-admission.js';
import type { CapacityQueueReason } from './session-capacity.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import type { Store } from './store.js';

export type RunExecutionSnapshot = {
  runId: string;
  status: string;
  cleanupRequired: boolean;
  cleanupReasons: string[];
  capacity: { occupied: number; limit: number; harnesses: Array<{ harness: HarnessId; occupied: number; limit: number }> };
  operations: Array<{ id: string; harness: HarnessId; label: string; status: 'queued' | 'admitted' | 'quarantined'; reason?: string }>;
  tasks: Array<{ id: string; label: string; harness: HarnessId; status: string; reason?: string }>;
  control?: { revision: number; generation: number; priority: number; spentMs: number; budgetMs: number; recoveryRequired: boolean };
};

function waitingReason(reason: CapacityQueueReason): string {
  switch (reason.kind) {
    case 'app-capacity': return `Waiting for an app slot (${reason.occupied}/${reason.limit} occupied).`;
    case 'harness-capacity': return `Waiting for a ${reason.harness === 'codex' ? 'Codex' : 'Grok'} slot (${reason.occupied}/${reason.limit} occupied).`;
    case 'worker-parallelism': return `Waiting for a worker slot in this plan (${reason.occupied}/${reason.limit} occupied).`;
    case 'writer-lease': return 'Waiting for another writer to release this workspace.';
  }
}

/** Observes retained state only. Reading activity must never discover a CLI or admit work. */
export function runExecutionSnapshot(store: Store, native: NativeAdmission, runId: string): RunExecutionSnapshot {
  const run = store.runs().find(item => item.id === runId);
  if (!run) throw new Error('Run does not exist.');
  const records = new DelegationRecords(store), controls = new DelegationControls(store);
  const control = controls.read(runId), tasks = records.tasks(runId), sessions = records.sessions(runId);
  const plan = records.plans(runId).find(item => item.id === records.authorizations(runId).find(item => item.id === control?.authorizationId)?.planId);
  const snapshot = native.snapshot(), waiting = new Map(snapshot.waiting.map(item => [item.id, item.reason]));
  const operations: RunExecutionSnapshot['operations'] = snapshot.operations.filter(item => item.runId === runId && ['queued', 'admitted', 'quarantined'].includes(item.state)).map(item => {
    const task = tasks.find(task => task.id === sessions.find(session => session.id === item.sessionId)?.taskId);
    const assignment = plan?.plan.assignments.find(assignment => assignment.id === task?.assignmentId);
    const purpose = item.purpose === 'model-turn' ? 'Agent turn' : item.purpose === 'command' ? 'Project check' : 'CLI discovery';
    const reason = waiting.get(item.id);
    return { id: item.id, harness: item.harness, label: assignment ? `${assignment.task} · ${purpose}` : purpose, status: item.state as 'queued' | 'admitted' | 'quarantined', ...(item.state === 'quarantined' ? { reason: 'Process cleanup is unconfirmed; this slot remains occupied.' } : reason ? { reason: waitingReason(reason) } : {}) };
  });
  const workspaceUnknown = new WorkspaceOwnership(store).snapshot().filter(item => item.state === 'cleanup-unconfirmed' && (item.runId === runId || item.runId === undefined && item.ownerId === runId && item.provenance?.kind === 'run' && item.provenance.id === runId && item.provenance.projectId === run.projectId && item.provenance.conversationId === run.conversationId));
  const legacyUnknown = snapshot.capacity.leases.filter(item => item.runId === runId && item.state === 'cleanup-unconfirmed' && !snapshot.operations.some(operation => operation.id === item.reservationId));
  const cleanupReasons: string[] = [];
  if (run.cleanupUnconfirmed || run.status === 'stop-unconfirmed') cleanupReasons.push('Run cleanup has not been confirmed.');
  if (workspaceUnknown.length) cleanupReasons.push(`${workspaceUnknown.length} workspace operation${workspaceUnknown.length === 1 ? '' : 's'} require cleanup review. Workspace ownership remains held independently of native slots.`);
  if (legacyUnknown.length) cleanupReasons.push(`${legacyUnknown.length} retained native slot${legacyUnknown.length === 1 ? '' : 's'} remain occupied until earlier process cleanup is confirmed.`);
  const open = operations.some(item => item.status !== 'quarantined') || control?.activities.some(item => item.state === 'active');
  const uncertain = cleanupReasons.length > 0 || operations.some(item => item.status === 'quarantined') || sessions.some(item => item.state === 'cleanup-unconfirmed') || control?.recoveryRequired || control?.activities.some(item => item.state === 'cleanup-unconfirmed') || tasks.some(task => task.state === 'cleanup-unconfirmed' || task.attempts.some(attempt => attempt.runtimeRecoveryRequired));
  if (uncertain && !cleanupReasons.length) cleanupReasons.push('Retained execution requires cleanup or recovery review.');
  const terminal = tasks.length > 0 && tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.state) || Boolean(task.blockedReason));
  let status: string = run.status;
  if (control) {
    status = controls.status(control);
    if (control.desired === 'running' && !open && !terminal) status = 'waiting';
    if (!open && terminal) status = tasks.every(task => task.state === 'completed') ? 'completed' : control.desired === 'stopped' ? 'stopped' : 'failed';
    else if (control.desired === 'paused' && open) status = 'pausing';
    else if (control.desired === 'stopped' && open) status = 'stopping';
  }
  if (!control && run.status !== 'stopping' && operations.some(item => item.status === 'admitted')) status = 'running';
  if (uncertain) status = 'interrupted';
  else if (status !== 'stopping' && (!control || control.desired === 'running') && operations.length && operations.every(item => item.status === 'queued') && !control?.activities.some(item => item.state === 'active')) status = 'waiting';
  return {
    runId, status, cleanupRequired: Boolean(uncertain), cleanupReasons,
    capacity: { occupied: snapshot.capacity.occupied, limit: snapshot.capacity.limits.app, harnesses: (['codex', 'grok'] as const).map(harness => ({ harness, occupied: snapshot.capacity.byHarness[harness] ?? 0, limit: snapshot.capacity.limits.perHarness })) },
    operations,
    tasks: tasks.map(task => {
      const assignment = plan?.plan.assignments.find(item => item.id === task.assignmentId);
      let reason: string | undefined = task.blockedReason === 'terminal-predecessor' ? 'A required predecessor did not complete.' : task.blockedReason === 'synthesis-failed-graph' ? 'The task graph could not produce a synthesis.' : undefined;
      if (!['completed', 'failed', 'cancelled', 'cleanup-unconfirmed'].includes(task.state) && !reason) {
        if (uncertain) reason = 'Waiting for cleanup or recovery review.';
        else if (control?.desired === 'paused') reason = status === 'pausing' ? 'Pause requested. Active work is settling; no new stage will start.' : 'Paused. No new stage will start.';
        else if (control?.desired === 'stopped') reason = 'Stopped. No new stage will start.';
        else if (task.dependencies.some(id => tasks.find(item => item.id === id)?.state !== 'completed')) reason = 'Waiting for dependencies.';
        else if (task.state === 'queued' || task.state === 'blocked') reason = 'Waiting for admission.';
      }
      return { id: task.id, label: assignment?.task ?? task.assignmentId, harness: assignment?.harness ?? run.harness ?? 'codex', status: task.state, ...(reason ? { reason } : {}) };
    }),
    ...(control ? { control: { revision: control.revision, generation: control.generation, priority: control.priority, spentMs: control.spentMs, budgetMs: control.budgetMs, recoveryRequired: Boolean(uncertain) } } : {}),
  };
}
