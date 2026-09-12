export type RunStatus = 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'stop-unconfirmed';
export type HarnessSelection = { harness: 'codex'; model: string; effort: string };
export type ProjectHarnessSettings = { revision: string | null; defaults: HarnessSelection | null; error?: string };
export type SaveProjectDefaultsInput = { projectId: string; defaults: HarnessSelection; expectedRevision: string | null };
export type ConversationSelectionInput = { conversationId: string; selection: HarnessSelection | null };
export type Project = { id: string; name: string; root: string; createdAt: string; harnessSettings?: ProjectHarnessSettings };
export type Conversation = { id: string; projectId: string; title: string; model: string; effort: string; createdAt: string; updatedAt: string; lastReadSequence: number };
export type Run = { id: string; projectId: string; conversationId: string; status: RunStatus; model: string; effort: string; settingsSource?: 'project' | 'conversation' | 'native'; projectSettingsRevision?: string | null; workspace: string; logsPath?: string; createdAt: string; updatedAt: string; lastActivityAt: string; error?: string };
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
export type SendInput = { conversationId: string; text: string; model?: string; effort?: string };
export interface DesktopBridge {
  snapshot(): Promise<WorkspaceSnapshot>;
  harness(): Promise<HarnessInfo>;
  addProject(): Promise<Project | null>;
  createConversation(projectId: string): Promise<Conversation>;
  saveProjectDefaults(input: SaveProjectDefaultsInput): Promise<ProjectHarnessSettings>;
  setConversationSelection(input: ConversationSelectionInput): Promise<Conversation>;
  send(input: SendInput): Promise<Run>;
  stop(runId: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
