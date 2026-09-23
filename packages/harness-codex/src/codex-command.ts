import { assertWorkspaceIdentity, workspaceIdentity } from '@randolph/runtime/workspace-identity';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AdapterCommand, AdapterCommandResult } from '@randolph/runtime/contracts';
import { object, meetsCodeModeMinVersion } from './codex-shared.js';
import { RpcClient } from './codex-rpc.js';
import {
  environment,
  modelsFrom,
  terminate,
  verifyCodePolicy,
  workspacePolicy,
  type CodexProcessHost,
} from './codex-launch.js';

export async function runCommand(
  host: CodexProcessHost,
  input: AdapterCommand,
): Promise<AdapterCommandResult> {
  input = { ...input };
  if (input.executable)
    return runCommand(host.withExecutable(input.executable), {
      ...input,
      executable: undefined,
    });
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: RpcClient | undefined;
  let output = '';
  let truncated = false;
  let exitCode: number | null = null;
  let error: string | undefined;
  let cleanupVerified = true;
  let dispatched = false;
  let stop: Promise<void> | undefined;
  const processId = randomUUID();
  let identity!: { device: number; inode: number };
  let command!: string[];
  const assertIdentity = (): void => assertWorkspaceIdentity(input.workspace, identity);
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const append = (text: string): void => {
    const remaining = 65_536 - output.length;
    if (text.length > remaining) truncated = true;
    const retained = text.slice(0, remaining);
    output += retained;
    if (retained) input.onOutput(retained);
  };
  const onAbort = (): void => {
    if (stop || !client) return;
    const ownedClient = client;
    stop = (async () => {
      if (dispatched) {
        try {
          await ownedClient.rpc('command/exec/terminate', { processId }, 2_000);
        } catch {
          /* Owned group termination follows. */
        }
      }
      ownedClient.fail(new Error('Command interrupted.'));
      if (child) await terminate(child);
    })();
  };
  const check = (): void => {
    if (input.signal.aborted) throw new Error('Command interrupted.');
    if (client?.error) throw client.error;
  };
  try {
    check();
    identity = input.workspaceIdentity
      ? { device: input.workspaceIdentity.device, inode: input.workspaceIdentity.inode }
      : workspaceIdentity(input.workspace);
    if (
      !Array.isArray(input.command) ||
      !input.command.length ||
      input.command.length > 100 ||
      !input.command[0] ||
      input.command.some(
        (value) => typeof value !== 'string' || value.includes(String.fromCharCode(0)),
      ) ||
      input.command.join('').length > 65_536
    )
      throw new Error('Verification requires a bounded command argument vector.');
    command = [...input.command];
    const version = host
      .exec(host.executablePath(), ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        env: environment(),
      })
      .trim();
    if (input.executableVersion && version !== input.executableVersion)
      throw new Error(
        'The selected CLI version changed after this run. Start fresh work before verification.',
      );
    if (!meetsCodeModeMinVersion(version))
      throw new Error('Native verification requires Codex CLI 0.149.0 or newer.');
    assertIdentity();
    child = host.launch(input.workspace, true);
    client = new RpcClient(child, host.timeout, (message) => {
      if (message.method !== 'command/exec/outputDelta') return;
      const params = object(message.params);
      if (params.processId !== processId) return;
      if (
        (params.stream !== 'stdout' && params.stream !== 'stderr') ||
        typeof params.deltaBase64 !== 'string' ||
        typeof params.capReached !== 'boolean'
      )
        throw new Error('Codex returned malformed command output.');
      if (params.capReached) truncated = true;
      append(decoders[params.stream].write(Buffer.from(params.deltaBase64, 'base64')));
    });
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    await host.initialize(client);
    assertIdentity();
    check();
    const account = object((await client.rpc('account/read', { refreshToken: false })).account);
    assertIdentity();
    if (account.type !== 'chatgpt')
      throw new Error('A ChatGPT-authenticated Codex session is required.');
    const models = modelsFrom(await client.rpc('model/list', { limit: 100, includeHidden: false }));
    assertIdentity();
    if (!models.length) throw new Error('Codex returned no model for permission verification.');
    check();
    const thread = await client.rpc('thread/start', {
      cwd: input.workspace,
      model: models[0].id,
      modelProvider: 'openai',
      ephemeral: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      baseInstructions:
        'Randolph is validating native command permissions. No agent turn is requested.',
    });
    assertIdentity();
    verifyCodePolicy(thread, input.workspace);
    check();
    assertIdentity();
    const dispatchedValue = input.onDispatch?.({ processId });
    if (dispatchedValue && typeof (dispatchedValue as { then?: unknown }).then === 'function') {
      void Promise.resolve(dispatchedValue).catch(() => {});
      throw new Error('Command dispatch callback must be synchronous.');
    }
    check();
    assertIdentity();
    dispatched = true;
    const result = await client.rpc(
      'command/exec',
      {
        command,
        cwd: input.workspace,
        sandboxPolicy: workspacePolicy(input.workspace),
        processId,
        streamStdoutStderr: true,
        streamStdin: false,
        tty: false,
        timeoutMs: 600_000,
        outputBytesCap: 32_768,
      },
      610_000,
    );
    assertIdentity();
    check();
    if (
      !Number.isInteger(result.exitCode) ||
      typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string'
    )
      throw new Error('Codex returned an invalid command result.');
    append(decoders.stdout.end());
    append(decoders.stderr.end());
    append(result.stdout);
    append(result.stderr);
    check();
    exitCode = result.exitCode as number;
  } catch (failure) {
    error = input.signal.aborted
      ? 'Command interrupted.'
      : failure instanceof Error
        ? failure.message
        : 'Native verification failed.';
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    if (stop) await stop;
    client?.fail(new Error('Command ended.'));
    if (child) cleanupVerified = await terminate(child);
    if (!cleanupVerified)
      error = error ?? 'Native command process-group cleanup could not be verified.';
  }
  return { exitCode, output, truncated, cleanupVerified, ...(error ? { error } : {}) };
}
