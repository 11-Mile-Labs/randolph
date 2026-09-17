import { setTimeout as delay } from 'node:timers/promises';
import { rmSync } from 'node:fs';
import type {
  AdapterRun,
  HarnessAdapter,
  HarnessInfo,
  HarnessInstallation,
} from '@randolph/runtime/contracts';
import { assertWorkspaceIdentity, workspaceIdentity } from '@randolph/runtime/workspace-identity';
import { WorkspaceFiles } from './workspace-files.js';
import { object, text, VERIFIED_VERSION, type GrokAdapterOptions } from './grok-shared.js';
export type { GrokAdapterOptions } from './grok-shared.js';
import { AcpClient } from './grok-rpc.js';
import { GrokProcessHost, terminate } from './grok-launch.js';
import { GrokAdmission } from './grok-admission.js';

export class GrokProtocol implements HarnessAdapter {
  private host: GrokProcessHost;
  private timeout: number;
  private admission: GrokAdmission;
  constructor(private options: GrokAdapterOptions = {}) {
    this.host = new GrokProcessHost(options);
    this.timeout = options.rpcTimeoutMs ?? 20_000;
    this.admission = new GrokAdmission(options, this.host, this.timeout, (executable, signal) =>
      new GrokProtocol({ ...this.options, executable }).discover(undefined, signal),
    );
  }
  async installations(): Promise<HarnessInstallation[]> {
    return this.admission.installations();
  }
  async discover(executable?: string, signal?: AbortSignal): Promise<HarnessInfo> {
    return this.admission.discover(executable, signal);
  }
  async run(
    input: AdapterRun,
  ): Promise<{ status: 'completed' | 'interrupted' | 'stop-unconfirmed' }> {
    if (input.signal.aborted) return { status: 'interrupted' };
    if (input.executable)
      return new GrokProtocol({ ...this.options, executable: input.executable }).run({
        ...input,
        executable: undefined,
      });
    const executionMode = input.executionMode ?? 'read-only';
    if (executionMode !== 'read-only' && executionMode !== 'code')
      throw new Error('Unsupported Grok execution mode.');
    const version = this.host.version();
    if (input.executableVersion && version !== input.executableVersion)
      throw new Error('The selected Grok CLI version changed before dispatch.');
    if (version !== VERIFIED_VERSION)
      throw new Error('This Grok CLI version has not been verified for Randolph.');
    this.admission.checkProvider(input.model);
    const workspace = input.workspace;
    const identity = input.workspaceIdentity ?? workspaceIdentity(workspace);
    assertWorkspaceIdentity(workspace, identity);
    const files = new WorkspaceFiles({ workspace, workspaceIdentity: identity, executionMode });
    const instance = this.host.launch(workspace, input.model, input.effort, executionMode);
    let sessionId = '';
    let stopping: Promise<void> | undefined;
    let failure: unknown;
    let completed = false;
    const catalogs = new Map<string, unknown>();
    const expectedTools = executionMode === 'code' ? ['read_file', 'write'] : ['read_file'];
    const validCatalog = (value: unknown): boolean =>
      Array.isArray(value) &&
      value.length === expectedTools.length &&
      new Set(value).size === expectedTools.length &&
      expectedTools.every((tool) => value.includes(tool));
    const client = new AcpClient(
      instance.child,
      this.timeout,
      (message) => {
        assertWorkspaceIdentity(workspace, identity);
        const params = object(message.params);
        if (message.method !== 'session/update') return;
        const update = object(params.update);
        const content = object(update.content);
        if (
          update.sessionUpdate === 'available_commands_update' &&
          typeof params.sessionId === 'string'
        ) {
          if (sessionId && params.sessionId !== sessionId) return;
          if (!catalogs.has(params.sessionId) && catalogs.size >= 8)
            throw new Error('Grok returned too many native tool catalogs.');
          const tools = object(update._meta).tools;
          catalogs.set(params.sessionId, tools);
          if (sessionId && !validCatalog(tools))
            throw new Error('Grok native tool catalog changed outside the approved tools.');
          return;
        }
        if (!sessionId || params.sessionId !== sessionId) return;
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          content.type === 'text' &&
          typeof content.text === 'string'
        )
          input.onEvent({
            type: 'message.delta',
            summary: 'Grok response',
            data: { messageId: 'grok-response', text: content.text },
          });
        else if (
          update.sessionUpdate === 'tool_call' ||
          update.sessionUpdate === 'tool_call_update'
        )
          input.onEvent({
            type: update.sessionUpdate === 'tool_call' ? 'tool.started' : 'tool.updated',
            summary: text(update.title, 200) || 'Grok tool activity',
            data: {
              toolCallId: text(update.toolCallId, 200),
              kind: text(update.kind, 100),
              status: text(update.status, 100),
            },
          });
        else if (update.sessionUpdate === 'agent_thought_chunk')
          input.onEvent({ type: 'agent.thinking', summary: 'Grok is thinking' });
      },
      (params) => {
        assertWorkspaceIdentity(workspace, identity);
        if (
          input.signal.aborted ||
          !sessionId ||
          params.sessionId !== sessionId ||
          typeof params.path !== 'string'
        )
          throw new Error('Wrong session.');
        return files.read({
          path: params.path,
          line: params.line as number | undefined,
          limit: params.limit as number | undefined,
        });
      },
      (method) => {
        input.onEvent({
          type: 'approval.denied',
          summary: 'Native request declined by Randolph',
          data: { method },
        });
      },
      (params) => {
        if (
          input.signal.aborted ||
          !sessionId ||
          params.sessionId !== sessionId ||
          typeof params.path !== 'string' ||
          typeof params.content !== 'string'
        )
          throw new Error('Invalid write request.');
        return files.write({ path: params.path, content: params.content });
      },
    );
    const abort = () => {
      if (stopping) return;
      stopping = (async () => {
        if (sessionId) {
          try {
            client.send({ method: 'session/cancel', params: { sessionId } });
            await delay(100);
          } catch {
            /* Owned process termination follows. */
          }
        }
        client.fail(new Error('Grok run interrupted.'));
        await terminate(instance.child);
      })();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    const check = () => {
      if (input.signal.aborted) throw new Error('Grok run interrupted.');
      if (client.error) throw client.error;
      assertWorkspaceIdentity(workspace, identity);
    };
    try {
      if (input.signal.aborted) abort();
      check();
      const { models } = await this.admission.initialize(client);
      check();
      if (!models.some((model) => model.id === input.model && model.efforts.includes(input.effort)))
        throw new Error('The selected Grok model or effort is unavailable.');
      const session = await client.rpc('session/new', {
        cwd: workspace,
        mcpServers: [],
        _meta: { sessionKind: 'headless', modelId: input.model, reasoningEffort: input.effort },
      });
      check();
      sessionId = text(session.sessionId, 200);
      if (!sessionId || object(session.models).currentModelId !== input.model)
        throw new Error('Grok did not confirm the selected session model.');
      const effort = Array.isArray(session.configOptions)
        ? session.configOptions.map(object).find((option) => option.id === 'reasoning_effort')
            ?.currentValue
        : undefined;
      if (effort !== input.effort)
        throw new Error('Grok did not confirm the selected session effort.');
      const catalogDeadline = Date.now() + Math.min(this.timeout, 5_000);
      while (!catalogs.has(sessionId) && Date.now() < catalogDeadline) {
        check();
        await delay(10);
      }
      check();
      if (!validCatalog(catalogs.get(sessionId)))
        throw new Error('Grok did not confirm the approved native tool catalog.');
      input.onEvent({
        type: 'session.started',
        summary: 'Connected to Grok',
        data: { sessionId, model: input.model, effort: input.effort, executionMode },
      });
      const result = await client.rpc(
        'session/prompt',
        {
          sessionId,
          prompt: [
            {
              type: 'text',
              text:
                'Conversation history (JSON; roles identify original speakers):\n' +
                JSON.stringify(input.messages) +
                '\nRespond to the final user message.',
            },
          ],
        },
        600_000,
      );
      check();
      if (result.stopReason !== 'end_turn')
        throw new Error('Grok did not report a completed turn.');
      completed = true;
    } catch (cause) {
      failure = cause;
    } finally {
      input.signal.removeEventListener('abort', abort);
      if (stopping) await stopping;
      client.fail(new Error('Run ended.'));
    }
    const clean = await terminate(instance.child);
    if (clean) rmSync(instance.directory, { recursive: true, force: true });
    if (!clean) return { status: 'stop-unconfirmed' };
    if (input.signal.aborted) return { status: 'interrupted' };
    if (failure) throw failure;
    if (!completed) throw new Error('Grok run ended without completion.');
    return { status: 'completed' };
  }
}
