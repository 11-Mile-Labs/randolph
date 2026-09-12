import type { CheckpointInput, ApproveReviewInput, ApprovePushInput, ConversationModeInput, ConversationSelectionInput, HarnessSelection, SaveProjectDefaultsInput, SendInput } from '@randolph/runtime/contracts';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings request.');
  return value as Record<string, unknown>;
}
function parseSelection(value: unknown): HarnessSelection {
  const input = record(value);
  if (input.harness !== 'codex' || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || typeof input.effort !== 'string' || !input.effort.trim() || input.effort.length > 32) throw new Error('Invalid harness, model, or effort.');
  return { harness: 'codex', model: input.model, effort: input.effort };
}
export function parseMode(value: unknown): ConversationModeInput {
  const input = record(value);
  if (input.executionMode !== 'read-only' && input.executionMode !== 'code') throw new Error('Invalid execution mode.');
  return { conversationId: parseId(input.conversationId), executionMode: input.executionMode };
}
export function parseReviewApproval(value: unknown): ApproveReviewInput {
  const input = record(value);
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 16_000 || input.message.includes('\0')) throw new Error('Enter a commit message of at most 16,000 characters.');
  return { reviewId: parseId(input.reviewId), message: input.message };
}
export function parseProjectDefaults(value: unknown): SaveProjectDefaultsInput {
  const input = record(value);
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedRevision))) throw new Error('Invalid settings revision.');
  return { projectId: parseId(input.projectId), defaults: parseSelection(input.defaults), expectedRevision: input.expectedRevision };
}
export function parseConversationSelection(value: unknown): ConversationSelectionInput {
  const input = record(value);
  return { conversationId: parseId(input.conversationId), selection: input.selection === null ? null : parseSelection(input.selection) };
}
export function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid project, conversation, or run identifier.');
  return value;
}
export function parseSend(value: unknown): SendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message request.');
  const input = value as Record<string, unknown>;
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64_000) throw new Error('Invalid message.');
  const message = { conversationId: parseId(input.conversationId), text: input.text };
  if (input.model === undefined && input.effort === undefined) return message;
  const selection = parseSelection({ harness: 'codex', model: input.model, effort: input.effort });
  return { ...message, model: selection.model, effort: selection.effort };
}

export function parsePushApproval(value: unknown): ApprovePushInput {
  const input = record(value);
  if (typeof input.revision !== 'string' || !/^[0-9a-f]{64}$/.test(input.revision)) throw new Error('Invalid push preview revision.');
  return { reviewId: parseId(input.reviewId), revision: input.revision };
}

export function parseCheckpoint(value: unknown): CheckpointInput {
  const input = record(value);
  if (typeof input.digest !== 'string' || !/^[0-9a-f]{64}$/.test(input.digest)) throw new Error('Invalid checkpoint digest.');
  return { runId: parseId(input.runId), digest: input.digest };
}
