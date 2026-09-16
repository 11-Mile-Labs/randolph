import { parseProjectContext, type ProjectContextSnapshot } from './project-context.js';
import type { PreparedMemory } from './memory.js';
import type { HarnessId, Run } from './contracts.js';

export type RecoveryContext = {
  projectContext?: ProjectContextSnapshot;
  harness: HarnessId;
  executable?: string;
  executableVersion?: string;
  model: string;
  effort: string;
  executionMode: NonNullable<Run['executionMode']>;
  settingsSource?: Run['settingsSource'];
  projectSettingsRevision?: string | null;
  memory?: PreparedMemory;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  title: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'The retained checkpoint context is incomplete. Restore files to inspect it without execution.',
    );
  return value as Record<string, unknown>;
}

function plainMessages(values: unknown[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  return values.map((value) => {
    const message = object(value);
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string'
    )
      throw new Error('The retained checkpoint contains invalid conversation context.');
    return { role: message.role, text: message.text };
  });
}

export function recoveryContext(
  metadata: Record<string, unknown>,
  kind: 'restart' | 'rerun',
  sourceRunId: string,
): RecoveryContext {
  const savedRun = object(metadata.run);
  const savedConversation = object(metadata.conversation);
  if (
    savedRun.id !== sourceRunId ||
    typeof savedRun.model !== 'string' ||
    typeof savedRun.effort !== 'string' ||
    (savedRun.executionMode !== 'code' && savedRun.executionMode !== 'read-only')
  )
    throw new Error(
      'The retained checkpoint does not contain a compatible run configuration. Restore files to inspect it without execution.',
    );
  let messages: RecoveryContext['messages'];
  if (savedRun.recoveryMessages !== undefined) {
    if (!Array.isArray(savedRun.recoveryMessages))
      throw new Error('The retained checkpoint contains invalid recovery context.');
    messages = plainMessages(savedRun.recoveryMessages);
  } else {
    if (!Array.isArray(metadata.messages))
      throw new Error(
        'The retained checkpoint does not contain restart context. Restore files to inspect it without execution.',
      );
    messages = metadata.messages.flatMap((value) => {
      const message = object(value);
      if (
        (message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.text !== 'string' ||
        typeof message.id !== 'string' ||
        typeof message.runId !== 'string'
      )
        throw new Error('The retained checkpoint contains invalid conversation context.');
      const isSourceAnswer =
        kind === 'rerun' &&
        message.role === 'assistant' &&
        message.runId === sourceRunId &&
        !message.id.startsWith(`${sourceRunId}:recovery:`);
      return isSourceAnswer
        ? []
        : [{ role: message.role as 'user' | 'assistant', text: message.text }];
    });
  }
  if (!messages.length || typeof savedConversation.title !== 'string')
    throw new Error(
      'The retained checkpoint does not contain restart context. Restore files to inspect it without execution.',
    );
  const harness = savedRun.harness === undefined ? 'codex' : savedRun.harness;
  if (harness !== 'codex' && harness !== 'grok')
    throw new Error(
      'The retained checkpoint contains an unknown harness route. Restore files to inspect it without execution.',
    );
  const settingsSource = savedRun.settingsSource;
  if (
    settingsSource !== undefined &&
    settingsSource !== 'project' &&
    settingsSource !== 'conversation' &&
    settingsSource !== 'native'
  )
    throw new Error('The retained checkpoint contains invalid harness provenance.');
  const projectSettingsRevision = savedRun.projectSettingsRevision;
  if (
    projectSettingsRevision !== undefined &&
    projectSettingsRevision !== null &&
    typeof projectSettingsRevision !== 'string'
  )
    throw new Error('The retained checkpoint contains invalid project settings provenance.');
  let projectContext: ProjectContextSnapshot | undefined;
  if (savedRun.projectContext !== undefined) {
    const saved = savedRun.projectContext as Partial<ProjectContextSnapshot> | null;
    if (
      !saved ||
      typeof saved !== 'object' ||
      saved.error !== undefined ||
      (saved.revision !== null &&
        (typeof saved.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(saved.revision)))
    )
      throw new Error('The retained project context is invalid. Restore files without execution.');
    if (saved.revision === null) {
      const empty = object(saved.value);
      if (
        Object.keys(empty).length !== 3 ||
        empty.purpose !== '' ||
        empty.instructions !== '' ||
        !Array.isArray(empty.documents) ||
        empty.documents.length !== 0
      )
        throw new Error('The retained empty project context is invalid.');
      projectContext = { revision: null, value: { purpose: '', instructions: '', documents: [] } };
    } else projectContext = { revision: saved.revision, value: parseProjectContext(saved.value) };
  }
  return {
    projectContext,
    harness,
    executable: typeof savedRun.executable === 'string' ? savedRun.executable : undefined,
    executableVersion:
      typeof savedRun.executableVersion === 'string' ? savedRun.executableVersion : undefined,
    model: savedRun.model,
    effort: savedRun.effort,
    executionMode: savedRun.executionMode,
    settingsSource,
    projectSettingsRevision,
    memory: savedRun.memory as PreparedMemory | undefined,
    messages,
    title: savedConversation.title,
  };
}

export function assertReconciledExternalActions(metadata: Record<string, unknown>): void {
  if (!Array.isArray(metadata.externalActions))
    throw new Error(
      'The retained checkpoint lacks external-action reconciliation context. Restore files to inspect it without execution.',
    );
  for (const value of metadata.externalActions) {
    const action = object(value);
    const push =
      action.push && typeof action.push === 'object'
        ? (action.push as Record<string, unknown>)
        : undefined;
    const result =
      push?.result && typeof push.result === 'object'
        ? (push.result as Record<string, unknown>)
        : undefined;
    if (
      action.originOperation === 'active' ||
      action.originOperation === 'cleanup-unconfirmed' ||
      action.status === 'delivering' ||
      action.status === 'interrupted' ||
      action.status === 'stop-unconfirmed' ||
      push?.status === 'pushing' ||
      push?.status === 'uncertain' ||
      result?.cleanupVerified === false
    )
      throw new Error(
        'Reconcile the retained external action and process cleanup before linked execution.',
      );
  }
}
