import type { DelegationTask } from './delegation-records.js';

/**
 * Shared by the graph scheduling loop, the attempt lifecycle's synthesis gate, and the per-task
 * runner's lease release. It lives in its own leaf so none of those modules has to import another
 * for it.
 *
 * A task with dependencies is born in the 'blocked' state with no blockedReason, so a bare
 * 'blocked' is the normal unsettled initial state and must stay schedulable. Only a blocked task
 * that also carries a blockedReason is settled: a reason outside the blocked state settles
 * nothing, because its single writer always assigns the state and the reason together.
 */
export const terminal = (task: DelegationTask): boolean =>
  ['completed', 'failed', 'cancelled', 'cleanup-unconfirmed'].includes(task.state) ||
  (task.state === 'blocked' && task.blockedReason !== undefined);
