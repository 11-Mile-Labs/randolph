import { isAbsolute } from 'node:path';
import type { ChatEventsInput, RestartCheckpointInput, SaveAppSettingsInput, SaveGlobalMemoryInput, CheckpointInput, ApproveReviewInput, ApprovePushInput, ConversationModeInput, ConversationSelectionInput, HarnessId, HarnessSelection, SaveProjectDefaultsInput, SendInput } from '@randolph/runtime/contracts';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings request.');
  return value as Record<string, unknown>;
}
function parseSelection(value: unknown): HarnessSelection {
  const input = record(value);
  const harness = parseHarnessId(input.harness);
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || typeof input.effort !== 'string' || !input.effort.trim() || input.effort.length > 32) throw new Error('Invalid harness, model, or effort.');
  return { harness, model: input.model, effort: input.effort };
}
export function parseHarnessId(value: unknown): HarnessId {
  if (value !== 'codex' && value !== 'grok') throw new Error('Unsupported harness.');
  return value;
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
  return { projectId: parseId(input.projectId), defaults: { ...parseSelection(input.defaults), ...(record(input.defaults).executable === undefined ? {} : { executable: parseExecutable(record(input.defaults).executable) }) }, expectedRevision: input.expectedRevision };
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
  if (input.harness === undefined && input.model === undefined && input.effort === undefined) return message;
  const selection = parseSelection({ harness: input.harness ?? 'codex', model: input.model, effort: input.effort });
  return { ...message, ...(input.harness === undefined ? {} : { harness: selection.harness }), model: selection.model, effort: selection.effort };
}
export function parseChatEvents(value: unknown): ChatEventsInput {
  const input = record(value);
  if (!Number.isSafeInteger(input.afterSequence) || Number(input.afterSequence) < 0) throw new Error('Invalid event cursor.');
  return { conversationId: parseId(input.conversationId), runId: parseId(input.runId), afterSequence: Number(input.afterSequence) };
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

function parseRevision(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid settings revision.');
  return value;
}
export function parseAppSettings(value: unknown): SaveAppSettingsInput {
  const input = record(value), preferences = record(input.value), notifications = record(preferences.notifications);
  if (!['system', 'light', 'dark'].includes(String(preferences.theme)) || typeof preferences.background !== 'boolean' || ['completed', 'failures', 'approvals'].some(key => typeof notifications[key] !== 'boolean')) throw new Error('Invalid application settings.');
  return { expectedRevision: parseRevision(input.expectedRevision), value: { theme: preferences.theme as 'system' | 'light' | 'dark', background: preferences.background, notifications: { completed: notifications.completed as boolean, failures: notifications.failures as boolean, approvals: notifications.approvals as boolean } } };
}
export function parseGlobalMemory(value: unknown): SaveGlobalMemoryInput {
  const input = record(value);
  if (typeof input.autoApprove !== 'boolean') throw new Error('Invalid global lesson setting.');
  return { autoApprove: input.autoApprove, expectedRevision: parseRevision(input.expectedRevision) };
}

export function parseLinkedCheckpoint(value: unknown): RestartCheckpointInput {
  const input = record(value);
  const checkpoint = parseCheckpoint({ runId: input.runId, digest: input.checkpointDigest });
  return { runId: checkpoint.runId, checkpointDigest: checkpoint.digest };
}


function parseExecutable(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.trim() !== value || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('CLI executable must be a bounded absolute path.');
  return value;
}
export function parseHarnessRequest(value: unknown): { projectId?: string; executable?: string; harness?: HarnessId } {
  if (value === undefined) return {};
  const input = record(value);
  return { ...(input.projectId === undefined ? {} : { projectId: parseId(input.projectId) }), ...(input.executable === undefined ? {} : { executable: parseExecutable(input.executable) ?? undefined }), ...(input.harness === undefined ? {} : { harness: parseHarnessId(input.harness) }) };
}
