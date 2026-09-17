import type { UIMessage } from 'ai';
import type { DesktopBridge } from '@randolph/runtime/contracts';

export type ChatBridge = Pick<
  DesktopBridge,
  'snapshot' | 'chatEvents' | 'send' | 'stop' | 'onChanged'
>;
export type NativeChatMessage = UIMessage<{ runId?: string; createdAt: string }>;
