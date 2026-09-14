import type { Run } from './contracts.js';

export const ACTIVE_RUN_STATUSES = new Set<Run['status']>(['starting', 'running', 'stopping', 'stop-unconfirmed']);
export const now = (): string => new Date().toISOString();
