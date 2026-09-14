import type { Run } from './contracts.js';

export const ACTIVE_RUN_STATUSES = new Set<Run['status']>(['starting', 'running', 'stopping', 'stop-unconfirmed']);
export const now = (): string => new Date().toISOString();

export function assertOpen(accepting: boolean): void {
  if (!accepting) throw new Error('Application is closing.');
}

export function conversationHasBlockingRun(runs: Array<Pick<Run, 'conversationId' | 'status' | 'cleanupUnconfirmed'>>, conversationId: string): boolean {
  return runs.some(run => run.conversationId === conversationId && (ACTIVE_RUN_STATUSES.has(run.status) || Boolean(run.cleanupUnconfirmed)));
}

export function conversationHasActiveRun(runs: Array<Pick<Run, 'conversationId' | 'status'>>, conversationId: string): boolean {
  return runs.some(run => run.conversationId === conversationId && ACTIVE_RUN_STATUSES.has(run.status));
}
