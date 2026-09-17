import type { DelegationTask } from './delegation-records.js';

/**
 * Shared by the graph scheduling loop and by the per-task runner's lease release. It lives in its
 * own leaf so neither of those modules has to import the other for it.
 */
export const terminal = (task: DelegationTask): boolean =>
  ['completed', 'failed', 'cancelled', 'cleanup-unconfirmed'].includes(task.state) ||
  Boolean(task.blockedReason);
