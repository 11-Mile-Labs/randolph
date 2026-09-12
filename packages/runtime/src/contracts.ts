export type RunStatus = 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'stop-unconfirmed';
export type Project = { id: string; name: string; root: string; createdAt: string };
export type Conversation = { id: string; projectId: string; title: string; model: string; effort: string; createdAt: string; updatedAt: string; lastReadSequence: number };
export type Run = { id: string; projectId: string; conversationId: string; status: RunStatus; model: string; effort: string; workspace: string; logsPath?: string; createdAt: string; updatedAt: string; lastActivityAt: string; error?: string };
export type Message = { id: string; conversationId: string; runId: string; role: 'user' | 'assistant'; text: string; createdAt: string };
export type RunEvent = { sequence: number; runId: string; projectId: string; conversationId: string; at: string; type: string; summary: string; data: Record<string, unknown> };
export type WorkspaceSnapshot = { projects: Project[]; conversations: Conversation[]; runs: Run[]; messages: Message[]; events: RunEvent[]; dataRoot: string };
export type HarnessModel = { id: string; name: string; efforts: string[]; defaultEffort: string };
export type HarnessInfo = { available: boolean; authenticated: boolean; version?: string; models: HarnessModel[]; reason?: string };
export type AdapterEvent = { type: string; summary: string; data?: Record<string, unknown> };
export type AdapterRun = { workspace: string; model: string; effort: string; messages: Pick<Message, 'role' | 'text'>[]; signal: AbortSignal; onEvent: (event: AdapterEvent) => void };
export interface HarnessAdapter {
  discover(): Promise<HarnessInfo>;
  run(input: AdapterRun): Promise<{ status: 'completed' | 'interrupted' | 'stop-unconfirmed' }>;
}
export type SendInput = { conversationId: string; text: string; model: string; effort: string };
export interface DesktopBridge {
  snapshot(): Promise<WorkspaceSnapshot>;
  harness(): Promise<HarnessInfo>;
  addProject(): Promise<Project | null>;
  createConversation(projectId: string): Promise<Conversation>;
  send(input: SendInput): Promise<Run>;
  stop(runId: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
