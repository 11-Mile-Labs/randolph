import type { SendInput } from '@randolph/runtime/contracts';
export function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid project, conversation, or run identifier.');
  return value;
}
export function parseSend(value: unknown): SendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message request.');
  const input = value as Record<string, unknown>;
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64_000 || typeof input.model !== 'string' || input.model.length > 200 || typeof input.effort !== 'string' || input.effort.length > 32) throw new Error('Invalid message, model, or effort.');
  return { conversationId: parseId(input.conversationId), text: input.text, model: input.model, effort: input.effort };
}
