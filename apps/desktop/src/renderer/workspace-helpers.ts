import type { Conversation, Run, RunEvent, WorkspaceSnapshot } from '@randolph/runtime/contracts';

export const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  projects: [],
  conversations: [],
  runs: [],
  messages: [],
  events: [],
  reviews: [],
  dataRoot: '',
};

export const BLOCKING_STATUSES = new Set<Run['status']>(['starting', 'running', 'stopping', 'stop-unconfirmed']);
export const NATIVE_EVENT_TYPES = new Set(['activity', 'session.started', 'message.delta', 'approval.denied', 'command.completed', 'file.changed', 'verification.check-started', 'verification.check-finished', 'verification.output']);

export function displayError(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export function latestSequence(events: RunEvent[], conversationId: string): number {
  let latest = 0;
  for (const event of events) {
    if (event.conversationId === conversationId) latest = Math.max(latest, event.sequence);
  }
  return latest;
}

export function unreadCount(events: RunEvent[], conversation: Conversation): number {
  let count = 0;
  for (const event of events) {
    if (event.conversationId === conversation.id && event.sequence > conversation.lastReadSequence) count += 1;
  }
  return count;
}
