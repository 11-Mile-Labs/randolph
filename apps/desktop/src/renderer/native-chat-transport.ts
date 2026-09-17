import type { ChatTransport, UIMessageChunk } from 'ai';
import type { Run } from '@randolph/runtime/contracts';
import { assistantId } from './chat-message-projection';
import type { ChatBridge, NativeChatMessage } from './chat-transport-types';

const LIVE = new Set<Run['status']>(['starting', 'running', 'stopping']);

export class RandolphChatTransport implements ChatTransport<NativeChatMessage> {
  private closed = false;
  private detach = new Set<() => void>();
  constructor(
    private bridge: ChatBridge,
    private conversationId: string,
    private onAccepted?: (run: Run) => void,
  ) {}

  private checkConversation(id: string): void {
    if (this.closed) throw new Error('Chat view is closed. Reopen the conversation.');
    if (id !== this.conversationId)
      throw new Error('Chat transport belongs to another conversation.');
  }

  async sendMessages(
    options: Parameters<ChatTransport<NativeChatMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.checkConversation(options.chatId);
    if (options.trigger !== 'submit-message')
      throw new Error('Use Run history for an explicit linked restart or rerun.');
    options.abortSignal?.throwIfAborted();
    const message = options.messages.at(-1);
    if (message?.role !== 'user' || message.parts.some((part) => part.type !== 'text'))
      throw new Error('Send a text message to this conversation.');
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    // The runtime supplies history, configuration, permissions and identity. Never trust a UI transcript as execution context.
    const run = await this.bridge.send({ conversationId: this.conversationId, text });
    this.onAccepted?.(run);
    if (options.abortSignal?.aborted) {
      await this.bridge.stop(run.id);
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    return this.watch(run, options.abortSignal);
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<NativeChatMessage>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    this.checkConversation(options.chatId);
    options.abortSignal?.throwIfAborted();
    const snapshot = await this.bridge.snapshot();
    const run = snapshot.runs.findLast(
      (item) => item.conversationId === this.conversationId && LIVE.has(item.status),
    );
    if (!run || this.closed) return null;
    return this.watch(run, options.abortSignal);
  }

  private watch(run: Run, signal?: AbortSignal): ReadableStream<UIMessageChunk> {
    if (this.closed)
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    let detach = () => {};
    let cancel = () => {};
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let ended = false;
        let reading = false;
        let dirty = false;
        let cursor = 0;
        const parts = new Set<string>();
        let unsubscribe = () => {};
        const cleanup = () => {
          unsubscribe();
          signal?.removeEventListener('abort', abort);
          this.detach.delete(detach);
        };
        cancel = () => {
          if (ended) return;
          ended = true;
          cleanup();
        };
        detach = () => {
          if (ended) return;
          cancel();
          controller.close();
        };
        const fail = (error: unknown) => {
          if (ended) return;
          ended = true;
          cleanup();
          controller.error(error);
        };
        const abort = () => {
          void stop();
        };
        const stop = async () => {
          try {
            await this.bridge.stop(run.id);
            detach();
          } catch (cause) {
            fail(cause);
          }
        };
        controller.enqueue({
          type: 'start',
          messageId: assistantId(run.id),
          messageMetadata: { runId: run.id, createdAt: run.createdAt },
        });
        const refresh = async () => {
          dirty = true;
          if (reading || ended) return;
          reading = true;
          try {
            while (dirty && !ended) {
              dirty = false;
              const { run: current, events } = await this.bridge.chatEvents({
                conversationId: this.conversationId,
                runId: run.id,
                afterSequence: cursor,
              });
              if (ended) break;
              if (!current)
                throw new Error(
                  'The retained run is unavailable. Reopen Run history to inspect its state.',
                );
              // Each connection rebuilds this response from durable events. Sequence filtering makes duplicate notifications harmless.
              for (const event of events) {
                if (
                  event.runId !== run.id ||
                  event.conversationId !== this.conversationId ||
                  event.sequence <= cursor
                )
                  continue;
                cursor = event.sequence;
                if (
                  event.type !== 'message.delta' ||
                  typeof event.data.messageId !== 'string' ||
                  typeof event.data.text !== 'string'
                )
                  continue;
                const id = `${run.id}:${event.data.messageId}`;
                if (!parts.has(id)) {
                  parts.add(id);
                  controller.enqueue({ type: 'text-start', id });
                }
                controller.enqueue({ type: 'text-delta', id, delta: event.data.text });
              }
              if (!LIVE.has(current.status)) {
                for (const id of parts) controller.enqueue({ type: 'text-end', id });
                if (current.status === 'failed' || current.status === 'stop-unconfirmed') {
                  controller.enqueue({
                    type: 'error',
                    errorText: current.error ?? `Native run ${current.status}.`,
                  });
                } else
                  controller.enqueue({
                    type: 'finish',
                    finishReason: current.status === 'completed' ? 'stop' : 'other',
                  });
                detach();
              }
            }
          } catch (cause) {
            fail(cause);
          } finally {
            reading = false;
          }
        };
        this.detach.add(detach);
        unsubscribe = this.bridge.onChanged(() => {
          void refresh();
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else void refresh();
      },
      // Losing a renderer/reader is not a command to stop native work.
      cancel: () => {
        cancel();
      },
    });
  }

  dispose(): void {
    this.closed = true;
    for (const detach of this.detach) detach();
  }
}
