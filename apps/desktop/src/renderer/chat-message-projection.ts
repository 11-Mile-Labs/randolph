import type { WorkspaceSnapshot } from '@randolph/runtime/contracts';
import type { NativeChatMessage } from './chat-transport-types';

export const assistantId = (runId: string) => `${runId}:assistant`;

/** SQLite messages are authoritative; one SDK response groups a run's native text parts. */
export function projectChatMessages(
  snapshot: WorkspaceSnapshot,
  conversationId: string,
): NativeChatMessage[] {
  const result: NativeChatMessage[] = [];
  for (const message of snapshot.messages
    .filter((item) => item.conversationId === conversationId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (message.role === 'user' || message.id.startsWith(`${message.runId}:recovery:`)) {
      result.push({
        id: message.id,
        role: message.role,
        metadata: { runId: message.runId, createdAt: message.createdAt },
        parts: [{ type: 'text', text: message.text }],
      });
    } else {
      let response = result.find((item) => item.id === assistantId(message.runId));
      if (!response) {
        response = {
          id: assistantId(message.runId),
          role: 'assistant',
          metadata: { runId: message.runId, createdAt: message.createdAt },
          parts: [],
        };
        result.push(response);
      }
      response.parts.push({ type: 'text', text: message.text });
    }
  }
  return result;
}
