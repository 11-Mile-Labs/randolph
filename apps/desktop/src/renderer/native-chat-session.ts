import { Chat } from '@ai-sdk/react';
import type { WorkspaceSnapshot } from '@randolph/runtime/contracts';
import { projectChatMessages } from './chat-message-projection';
import type { ChatBridge, NativeChatMessage } from './chat-transport-types';
import { RandolphChatTransport } from './native-chat-transport';

/** Keeps SDK presentation local to a conversation while native execution outlives its view. */
export class NativeChatSession {
  readonly chat: Chat<NativeChatMessage>;
  readonly transport: RandolphChatTransport;
  settled: Promise<void> = Promise.resolve();
  private admission?: ReturnType<typeof Promise.withResolvers<void>>;
  private connecting = false;
  private disposed = false;
  private viewers = 0;
  constructor(
    private bridge: ChatBridge,
    readonly conversationId: string,
    snapshot: WorkspaceSnapshot,
  ) {
    this.transport = new RandolphChatTransport(bridge, conversationId, () => {
      this.admission?.resolve();
      this.admission = undefined;
    });
    this.chat = new Chat<NativeChatMessage>({
      id: conversationId,
      messages: projectChatMessages(snapshot, conversationId),
      transport: this.transport,
      onError: (error) => {
        this.admission?.reject(error);
        this.admission = undefined;
      },
    });
  }
  attach(): () => void {
    this.viewers += 1;
    void this.connect();
    return () => {
      this.viewers -= 1;
      queueMicrotask(() => {
        if (this.viewers === 0) this.dispose();
      });
    };
  }
  sync(snapshot: WorkspaceSnapshot): void {
    if (
      this.disposed ||
      this.connecting ||
      this.admission ||
      this.chat.status === 'submitted' ||
      this.chat.status === 'streaming'
    )
      return;
    const messages = projectChatMessages(snapshot, this.conversationId);
    if (JSON.stringify(messages) !== JSON.stringify(this.chat.messages))
      this.chat.messages = messages;
  }
  async connect(): Promise<void> {
    if (
      this.connecting ||
      this.disposed ||
      this.admission ||
      this.chat.status === 'submitted' ||
      this.chat.status === 'streaming'
    )
      return;
    this.connecting = true;
    try {
      await this.chat.resumeStream();
    } finally {
      this.connecting = false;
      await this.refresh();
    }
  }
  async send(text: string): Promise<void> {
    if (
      this.disposed ||
      this.connecting ||
      this.admission ||
      this.chat.status === 'submitted' ||
      this.chat.status === 'streaming'
    )
      throw new Error('This conversation already has active work.');
    const admission = Promise.withResolvers<void>();
    this.admission = admission;
    this.settled = this.finishSend(
      this.chat.sendMessage({ text, metadata: { createdAt: new Date().toISOString() } }),
    );
    await admission.promise;
  }
  private async finishSend(completed: Promise<void>): Promise<void> {
    try {
      await completed;
    } catch (cause) {
      this.admission?.reject(cause);
    } finally {
      this.admission?.reject(this.chat.error ?? new Error('Message was not admitted.'));
      this.admission = undefined;
      await this.refresh();
    }
  }
  private async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      this.sync(await this.bridge.snapshot());
    } catch {
      /* Transport errors remain visible; focus/reconnect can reload the durable state. */
    }
  }
  dispose(): void {
    this.disposed = true;
    this.transport.dispose();
  }
}
