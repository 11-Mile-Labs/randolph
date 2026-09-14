import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { statSync } from 'node:fs';
import { canonicalProject } from './workspace.js';
import { readHarnessSettings } from './harness-settings.js';
import type {
  CheckpointInput,
  CheckpointRestore,
  ChatEventsInput,
  ChatEventsResult,
  Conversation,
  Project,
  WorkspaceSnapshot,
} from './contracts.js';
import type { WorkspaceLease } from './workspace-leases.js';
import { assertOpen, now } from './runtime-status.js';
import type { RuntimeBindings } from './runtime-bindings.js';

export function workspaceSnapshot(host: Pick<RuntimeBindings, 'store'>): WorkspaceSnapshot {
  const snapshot = host.store.snapshot();
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      harnessSettings: readHarnessSettings(project.root),
    })),
  };
}

export function chatEvents(
  host: Pick<RuntimeBindings, 'store'>,
  input: ChatEventsInput,
): ChatEventsResult {
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)
    throw new Error('Invalid event cursor.');
  return host.store.chatEvents(input.conversationId, input.runId, input.afterSequence);
}

export function restoreCheckpoint(
  host: Pick<RuntimeBindings, 'accepting' | 'workspaces' | 'workspaceOwnership' | 'checkpoints'>,
  input: CheckpointInput,
  destination: string,
): CheckpointRestore {
  assertOpen(host.accepting);
  const held = new Map<string, WorkspaceLease>();
  let failure: unknown;
  try {
    const lease = host.workspaces.own(
      destination,
      { kind: 'checkpoint-export', id: randomUUID() },
      held,
    );
    host.workspaceOwnership.assert(lease);
    const result = host.checkpoints.restore(input, destination);
    host.workspaceOwnership.bind(lease);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    host.workspaces.release(held, failure);
  }
}

export function addProject(
  host: Pick<RuntimeBindings, 'accepting' | 'store' | 'changed'>,
  path: string,
): Project {
  assertOpen(host.accepting);
  if (!statSync(path).isDirectory()) throw new Error('Choose a project folder.');
  const root = canonicalProject(path);
  const existing = host.store.projects().find((project) => project.root === root);
  if (existing) return existing;
  const project = { id: randomUUID(), name: basename(root), root, createdAt: now() };
  host.store.putProject(project);
  host.changed();
  return project;
}

export function createConversation(
  host: Pick<RuntimeBindings, 'accepting' | 'store' | 'changed'>,
  projectId: string,
): Conversation {
  assertOpen(host.accepting);
  if (!host.store.projects().some((project) => project.id === projectId))
    throw new Error('Project does not exist.');
  const conversation: Conversation = {
    id: randomUUID(),
    projectId,
    title: 'New conversation',
    model: '',
    effort: '',
    createdAt: now(),
    updatedAt: now(),
    lastReadSequence: 0,
  };
  host.store.putConversation(conversation);
  host.changed();
  return conversation;
}

export function markRead(
  host: Pick<RuntimeBindings, 'store' | 'changed'> & { conversation(id: string): Conversation },
  conversationId: string,
): void {
  const conversation = host.conversation(conversationId);
  const sequence =
    host.store
      .events()
      .filter((event) => event.conversationId === conversationId)
      .at(-1)?.sequence ?? 0;
  if (sequence <= conversation.lastReadSequence) return;
  host.store.putConversation({ ...conversation, lastReadSequence: sequence });
  host.changed();
}

export function requireProject(host: Pick<RuntimeBindings, 'store'>, id: string): Project {
  const project = host.store.projects().find((value) => value.id === id);
  if (!project) throw new Error('Project does not exist.');
  return project;
}

export function requireConversation(
  host: Pick<RuntimeBindings, 'store'>,
  id: string,
): Conversation {
  const conversation = host.store.conversations().find((value) => value.id === id);
  if (!conversation) throw new Error('Conversation does not exist.');
  return conversation;
}
