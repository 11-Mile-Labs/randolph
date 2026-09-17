import {
  parseInspectProject,
  parseSetupApproval,
  parseHarnessRequest,
  parseLinkedCheckpoint,
  parseGlobalMemory,
  parseCheckpoint,
  parsePushApproval,
  parseChatEvents,
  parseSend,
  parseId,
  parseProjectDefaults,
  parseConversationSelection,
  parseMode,
  parseReviewApproval,
} from './validation.js';
import { parseMemoryCommand, parseLessonRef } from './memory-validation.js';
import {
  parseApproveDelegation,
  parseRejectDelegation,
  parseReviseDelegation,
  parseSaveDelegationPreset,
} from './delegation-validation.js';
import type { Runtime } from '@randolph/runtime';

export type GuardedCommand = (channel: string, action: (value: unknown) => unknown) => void;

export type IpcHost = {
  /** The bootstrap's guarded registrar: it owns the single sender check for every channel. */
  command: GuardedCommand;
  /**
   * Main-window dialog for checkpoint restore. Resolves to the realpath-backed destination
   * folder, or null when the operator cancels so `restoreCheckpoint` still answers null.
   */
  chooseRestoreDirectory: () => Promise<string | null>;
  /** Main-window dialog for adding a project. Resolves to null when the operator cancels. */
  chooseProjectDirectory: () => Promise<string | null>;
};

function registerDelegationCommands(runtime: Runtime, command: GuardedCommand): void {
  command('randolph:run-execution-snapshot', (input) =>
    runtime.runExecutionSnapshot(parseId(input)),
  );
  command('randolph:delegation-snapshot', (input) => runtime.delegationSnapshot(parseId(input)));
  command('randolph:revise-delegation', (input) =>
    runtime.reviseDelegation(parseReviseDelegation(input)),
  );
  command('randolph:reject-delegation', (input) =>
    runtime.rejectDelegation(parseRejectDelegation(input)),
  );
  command('randolph:approve-delegation', (input) =>
    runtime.approveDelegation(parseApproveDelegation(input)),
  );
  command('randolph:save-delegation-preset', (input) =>
    runtime.saveDelegationPreset(parseSaveDelegationPreset(input)),
  );
}

function registerMemoryCommands(runtime: Runtime, command: GuardedCommand): void {
  command('randolph:save-global-memory', (input) =>
    runtime.saveGlobalMemory(parseGlobalMemory(input)),
  );
  command('randolph:memory', (id) => runtime.memorySnapshot(parseId(id)));
  command('randolph:memory-command', (input) => runtime.memoryCommand(parseMemoryCommand(input)));
  command('randolph:memory-history', (input) => {
    if (!input || typeof input !== 'object' || !('projectId' in input) || !('reference' in input))
      throw new Error('Invalid memory history request.');
    return runtime.memoryHistory(parseId(input.projectId), parseLessonRef(input.reference));
  });
}

function registerRecoveryCommands(runtime: Runtime, host: IpcHost): void {
  host.command('randolph:restart-run', (input) => runtime.restartRun(parseLinkedCheckpoint(input)));
  host.command('randolph:rerun-checkpoint', (input) =>
    runtime.rerunFromCheckpoint(parseLinkedCheckpoint(input)),
  );
  host.command('randolph:restore-checkpoint', async (input) => {
    const checkpoint = parseCheckpoint(input);
    const destination = await host.chooseRestoreDirectory();
    if (destination === null) return null;
    return runtime.restoreCheckpoint(checkpoint, destination);
  });
}

function registerProjectCommands(runtime: Runtime, host: IpcHost): void {
  host.command('randolph:project-setup', (id) => runtime.projectSetup(parseId(id)));
  host.command('randolph:reconcile-setup-cleanup', (id) =>
    runtime.reconcileProjectSetupCleanup(parseId(id)),
  );
  host.command('randolph:inspect-project', (input) =>
    runtime.inspectProject(parseInspectProject(input)),
  );
  host.command('randolph:approve-project-setup', (input) =>
    runtime.approveProjectSetup(parseSetupApproval(input)),
  );
  host.command('randolph:harness-installations', (input) =>
    runtime.harnessInstallations(parseHarnessRequest(input).harness),
  );
  host.command('randolph:harness', (input) => {
    const request = parseHarnessRequest(input);
    return runtime.harness(request.projectId, request.executable, request.harness);
  });
  host.command('randolph:add-project', async () => {
    const directory = await host.chooseProjectDirectory();
    if (directory === null) return null;
    return runtime.addProject(directory);
  });
  host.command('randolph:save-project-defaults', (input) =>
    runtime.saveProjectDefaults(parseProjectDefaults(input)),
  );
}

function registerConversationCommands(runtime: Runtime, command: GuardedCommand): void {
  command('randolph:chat-events', (input) => runtime.chatEvents(parseChatEvents(input)));
  command('randolph:create-conversation', (id) => runtime.createConversation(parseId(id)));
  command('randolph:conversation-selection', (input) =>
    runtime.setConversationSelection(parseConversationSelection(input)),
  );
  command('randolph:execution-mode', (input) => runtime.setExecutionMode(parseMode(input)));
  command('randolph:send', (input) => runtime.send(parseSend(input)));
  command('randolph:stop', (id) => runtime.stop(parseId(id)));
  command('randolph:mark-read', (id) => runtime.markRead(parseId(id)));
}

function registerDeliveryCommands(runtime: Runtime, command: GuardedCommand): void {
  command('randolph:integrate', (id) => runtime.integrateConversation(parseId(id)));
  command('randolph:confirm-integration', (id) => runtime.confirmIntegration(parseId(id)));
  command('randolph:prepare-review', (id) => runtime.prepareReview(parseId(id)));
  command('randolph:verify-review', (id) => runtime.verifyReview(parseId(id)));
  command('randolph:approve-review', (input) => runtime.approveReview(parseReviewApproval(input)));
  command('randolph:preview-push', (id) => runtime.previewPush(parseId(id)));
  command('randolph:approve-push', (input) => runtime.approvePush(parsePushApproval(input)));
  command('randolph:check-push', (id) => runtime.checkPush(parseId(id)));
  command('randolph:stop-push', (id) => runtime.stopPush(parseId(id)));
  command('randolph:stop-review', (id) => runtime.stopReview(parseId(id)));
}

/**
 * Registers every domain channel through the bootstrap's guarded registrar. The bootstrap keeps
 * the snapshot, navigation acknowledgement and app-settings channels because those read or write
 * its own navigation and tray state.
 */
export function registerDomainCommands(runtime: Runtime, host: IpcHost): void {
  registerDelegationCommands(runtime, host.command);
  registerMemoryCommands(runtime, host.command);
  registerRecoveryCommands(runtime, host);
  registerProjectCommands(runtime, host);
  registerConversationCommands(runtime, host.command);
  registerDeliveryCommands(runtime, host.command);
}
