import { randomUUID } from 'node:crypto';
import type { NativeAdmission } from './native-admission.js';
import type { Store } from './store.js';
import type { RunWorkspace } from './run-workspace.js';
import type { WorkspaceOwnership } from './workspace-ownership.js';
import type { WorkspaceLease } from './workspace-leases.js';
import {
  assertHarnessRoute,
  readHarnessSettings,
  writeHarnessSettings,
} from './harness-settings.js';
import { assertOpen, now } from './runtime-status.js';
import type {
  Conversation,
  ConversationModeInput,
  ConversationSelectionInput,
  HarnessAdapter,
  HarnessId,
  HarnessInfo,
  HarnessInstallation,
  HarnessSelection,
  Project,
  ProjectHarnessSettings,
  Run,
  SaveProjectDefaultsInput,
} from './contracts.js';

/** How long a conversation's code-mode verification may stand in for discovery at dispatch. */
const CODE_MODE_VERIFICATION_REUSE_MS = 30_000;

type CodeModeVerification = { key: string; info: HarnessInfo; expiresAt: number };

export class RuntimeHarness {
  private readonly codeModeVerifications = new Map<string, CodeModeVerification>();
  constructor(
    private readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>,
    private readonly nativeAdmission: NativeAdmission,
    private readonly store: Store,
    private readonly workspaces: RunWorkspace,
    private readonly ownership: WorkspaceOwnership,
    private readonly isBusy: (conversationId: string) => boolean,
    private readonly isAccepting: () => boolean,
    private readonly changed: () => void,
    private readonly project: (id: string) => Project,
    private readonly conversation: (id: string) => Conversation,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  adapterFor(harness: HarnessId): HarnessAdapter {
    const adapter = this.adapters[harness];
    if (!adapter) throw new Error(`No installed ${harness} harness route is available.`);
    return adapter;
  }

  adapterForRun(run: Run): HarnessAdapter {
    return this.adapterFor(run.harness ?? 'codex');
  }

  selectionFor(conversation: Conversation): HarnessSelection | undefined {
    if (!conversation.harness && !conversation.model && !conversation.effort) return undefined;
    return {
      harness: conversation.harness ?? 'codex',
      model: conversation.model,
      effort: conversation.effort,
    };
  }

  validateExecutionMode(mode: NonNullable<Run['executionMode']>, info: HarnessInfo): void {
    if (mode === 'code' && !info.executionModes?.includes('code'))
      throw new Error('Code mode is not verified for this installed harness.');
    if (info.executionModes && !info.executionModes.includes(mode))
      throw new Error(info.reason ?? 'Execution is not verified for this installed harness.');
  }

  validateSelection(selection: HarnessSelection, info: HarnessInfo): void {
    if (!info.available || !info.authenticated)
      throw new Error(info.reason ?? `Sign into the installed ${selection.harness} CLI first.`);
    const model = info.models.find((candidate) => candidate.id === selection.model);
    if (info.harness !== selection.harness || !model || !model.efforts.includes(selection.effort))
      throw new Error('Choose an available model and effort.');
  }

  async installations(harnessId: HarnessId = 'codex'): Promise<HarnessInstallation[]> {
    const adapter = this.adapterFor(harnessId);
    return (adapter.installations ? await adapter.installations() : []).map((item) => ({
      ...item,
      harness: harnessId,
    }));
  }

  private async assertInstalled(harness: HarnessId, executable?: string | null): Promise<void> {
    if (
      executable &&
      !(await this.installations(harness)).some((item) => item.executable === executable)
    )
      throw new Error(
        'The selected CLI is no longer discovered for this harness. Choose an installed CLI in Project settings.',
      );
  }

  async inspectExecutable(harness: HarnessId, executable?: string | null): Promise<HarnessInfo> {
    await this.assertInstalled(harness, executable);
    const info = await this.nativeAdmission
      .adapter(harness, this.adapterFor(harness), {
        owner: { kind: 'app-discovery', id: randomUUID() },
      })
      .discover(executable ?? undefined);
    if (info.harness && info.harness !== harness)
      throw new Error('Harness discovery returned a mismatched route.');
    return { ...info, harness };
  }

  async inspect(
    projectId?: string,
    executable?: string,
    harnessId?: HarnessId,
  ): Promise<HarnessInfo> {
    if (executable) return this.inspectExecutable(harnessId ?? 'codex', executable);
    if (!projectId) return this.inspectExecutable(harnessId ?? 'codex');
    const settings = readHarnessSettings(this.project(projectId).root);
    if (settings.error)
      return { available: false, authenticated: false, models: [], reason: settings.error };
    const selectedHarness = harnessId ?? settings.defaults?.harness ?? 'codex';
    const selectedExecutable =
      settings.defaults?.harness === selectedHarness ? settings.defaults.executable : undefined;
    try {
      return await this.inspectExecutable(selectedHarness, selectedExecutable);
    } catch (cause) {
      return {
        available: false,
        authenticated: false,
        models: [],
        reason: cause instanceof Error ? cause.message : 'CLI discovery failed.',
      };
    }
  }

  private verificationKey(
    projectId: string,
    harness: HarnessId,
    executable: string | null | undefined,
    settingsRevision: string | null | undefined,
  ): string {
    return [projectId, harness, executable ?? '', settingsRevision ?? ''].join('\0');
  }

  /**
   * Discovery for an ordinary dispatch. A conversation that just switched to code mode was
   * verified against the same project, harness, executable, and settings revision moments ago;
   * that verification is consumed once here instead of spawning the CLI again. Everything
   * consequential is still checked live at dispatch or launch: enabled routes and the settings
   * revision from a fresh read, the resolved executable's presence among the adapter's
   * installations here, and its version and (for adapters that promise it) authentication inside
   * the adapter before any model turn. Adapters that cannot enumerate installations always
   * discover afresh.
   */
  async discoverForDispatch(
    conversation: Conversation,
    harness: HarnessId,
    executable: string | null | undefined,
    settingsRevision: string | null | undefined,
  ): Promise<HarnessInfo> {
    const verified = this.codeModeVerifications.get(conversation.id);
    this.codeModeVerifications.delete(conversation.id);
    const key = this.verificationKey(conversation.projectId, harness, executable, settingsRevision);
    const resolved = verified?.info.executable ?? executable;
    if (
      verified?.key === key &&
      verified.expiresAt > this.clock() &&
      resolved &&
      this.adapterFor(harness).installations
    ) {
      await this.assertInstalled(harness, resolved);
      return verified.info;
    }
    return this.inspectExecutable(harness, executable);
  }

  async setExecutionMode(input: ConversationModeInput): Promise<Conversation> {
    assertOpen(this.isAccepting());
    if (input.executionMode !== 'read-only' && input.executionMode !== 'code')
      throw new Error('Invalid execution mode.');
    if (
      this.conversation(input.conversationId).kind === 'project-setup' &&
      input.executionMode !== 'read-only'
    )
      throw new Error('Project setup is read-only.');
    let verified: CodeModeVerification | undefined;
    if (input.executionMode === 'code') {
      const conversation = this.conversation(input.conversationId);
      const project = this.project(conversation.projectId);
      const settings = readHarnessSettings(project.root);
      if (settings.error) throw new Error(settings.error);
      const selection = this.selectionFor(conversation) ?? settings.defaults;
      const harness = selection?.harness ?? 'codex';
      const executable =
        settings.defaults?.harness === harness ? settings.defaults.executable : undefined;
      const info = await this.inspectExecutable(harness, executable);
      assertOpen(this.isAccepting());
      assertHarnessRoute(settings, harness, info.executable);
      if (!info.authenticated || !info.executionModes?.includes('code'))
        throw new Error('Code mode is not verified for this installed harness.');
      if (this.adapterFor(harness).launchVerifiesAuthentication)
        verified = {
          key: this.verificationKey(project.id, harness, executable, settings.revision),
          info,
          expiresAt: this.clock() + CODE_MODE_VERIFICATION_REUSE_MS,
        };
    }
    if (this.isBusy(input.conversationId))
      throw new Error('Wait for active work to finish before changing execution mode.');
    const conversation = {
      ...this.conversation(input.conversationId),
      executionMode: input.executionMode,
      updatedAt: now(),
    };
    this.store.putConversation(conversation);
    this.codeModeVerifications.delete(conversation.id);
    if (verified) this.codeModeVerifications.set(conversation.id, verified);
    this.changed();
    return conversation;
  }

  async saveProjectDefaults(input: SaveProjectDefaultsInput): Promise<ProjectHarnessSettings> {
    assertOpen(this.isAccepting());
    const project = this.project(input.projectId);
    const info = await this.inspectExecutable(input.defaults.harness, input.defaults.executable);
    assertOpen(this.isAccepting());
    this.validateSelection(input.defaults, info);
    const held = new Map<string, WorkspaceLease>();
    let failure: unknown;
    try {
      const lease = this.workspaces.own(
        project.root,
        { kind: 'harness-settings', id: randomUUID(), projectId: project.id },
        held,
      );
      this.ownership.assert(lease);
      const settings = writeHarnessSettings(
        project.root,
        input.defaults,
        input.expectedRevision,
        input.enabledRoutes,
      );
      this.changed();
      return settings;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.workspaces.release(held, failure);
    }
  }

  async setConversationSelection(input: ConversationSelectionInput): Promise<Conversation> {
    assertOpen(this.isAccepting());
    this.conversation(input.conversationId);
    if (input.selection) {
      const conversation = this.conversation(input.conversationId);
      const project = this.project(conversation.projectId);
      const settings = readHarnessSettings(project.root);
      if (settings.error) throw new Error(settings.error);
      const info = await this.inspectExecutable(
        input.selection.harness,
        settings.defaults?.harness === input.selection.harness
          ? settings.defaults.executable
          : undefined,
      );
      assertOpen(this.isAccepting());
      assertHarnessRoute(settings, input.selection.harness, info.executable);
      this.validateSelection(input.selection, info);
    }
    const conversation = {
      ...this.conversation(input.conversationId),
      harness: input.selection?.harness,
      model: input.selection?.model ?? '',
      effort: input.selection?.effort ?? '',
      updatedAt: now(),
    };
    this.store.putConversation(conversation);
    this.changed();
    return conversation;
  }
}
