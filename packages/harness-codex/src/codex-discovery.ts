import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HarnessInfo, HarnessInstallation, HarnessModel } from '@randolph/runtime/contracts';
import {
  object,
  meetsCodeModeMinVersion,
  meetsApplicationToolsMinVersion,
} from './codex-shared.js';
import { RpcClient } from './codex-rpc.js';
import {
  environment,
  executableCandidates,
  modelsFrom,
  terminate,
  type CodexProcessHost,
} from './codex-launch.js';

export async function installations(host: CodexProcessHost): Promise<HarnessInstallation[]> {
  const paths = [
    ...new Set(
      [
        ...(host.options.executable ? [host.options.executable] : []),
        ...executableCandidates(),
      ].map((path) => {
        try {
          return realpathSync(path);
        } catch {
          return path;
        }
      }),
    ),
  ];
  // Candidate enumeration must not create a CLI process outside discovery's lifecycle.
  return paths.map((executable) => ({ executable }));
}
export async function discover(
  host: CodexProcessHost,
  executable?: string,
  signal?: AbortSignal,
): Promise<HarnessInfo> {
  if (signal?.aborted)
    return {
      available: false,
      authenticated: false,
      models: [],
      cleanupVerified: true,
      reason: 'Discovery was cancelled before dispatch.',
    };
  if (executable) return discover(host.withExecutable(executable), undefined, signal);
  let selected: string;
  try {
    selected = host.executablePath();
  } catch {
    return {
      available: false,
      authenticated: false,
      models: [],
      cleanupVerified: true,
      reason: 'Codex CLI was not found. Install it and sign in with ChatGPT.',
    };
  }
  const resolved = existsSync(selected) ? realpathSync(selected) : selected;
  if (resolved !== selected) return discover(host.withExecutable(resolved), undefined, signal);
  let version: string;
  try {
    version = host
      .exec(host.executablePath(), ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        env: environment(),
      })
      .trim();
  } catch {
    return {
      available: false,
      authenticated: false,
      models: [],
      cleanupVerified: false,
      reason: 'Codex CLI could not be started. Install it and sign in with ChatGPT.',
    };
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: RpcClient | undefined;
  let stop: Promise<boolean> | undefined;
  let info: HarnessInfo = {
    executable: selected,
    available: true,
    authenticated: false,
    commandLifecycle: false,
    version,
    models: [],
    cleanupVerified: false,
  };
  const onAbort = (): void => {
    client?.fail(new Error('Discovery was cancelled.'));
    if (child) stop ??= terminate(child);
  };
  try {
    if (signal?.aborted)
      return {
        ...info,
        cleanupVerified: true,
        reason: 'Discovery was cancelled before dispatch.',
      };
    child = host.launch(homedir());
    client = new RpcClient(child, host.timeout, () => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    await host.initialize(client);
    const account = object((await client.rpc('account/read', { refreshToken: false })).account);
    if (account.type !== 'chatgpt')
      info.reason =
        'Sign into the Codex CLI with ChatGPT. API-key authentication is not supported.';
    else {
      const models: HarnessModel[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.rpc('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        models.push(...modelsFrom(page));
        cursor =
          typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        if (cursor && seen.has(cursor))
          throw new Error('Codex model pagination repeated a cursor.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      info = {
        ...info,
        applicationTools: meetsApplicationToolsMinVersion(version),
        commandLifecycle: meetsCodeModeMinVersion(version),
        authenticated: true,
        models,
        executionModes: meetsCodeModeMinVersion(version) ? ['read-only', 'code'] : ['read-only'],
      };
    }
  } catch (error) {
    info = {
      ...info,
      authenticated: false,
      models: [],
      reason: error instanceof Error ? error.message : 'Codex discovery failed.',
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    client?.fail(new Error('Discovery ended.'));
    if (child) info.cleanupVerified = await (stop ?? terminate(child));
  }
  if (!info.cleanupVerified)
    info = {
      ...info,
      authenticated: false,
      commandLifecycle: false,
      models: [],
      executionModes: [],
      reason: 'Native discovery cleanup could not be confirmed.',
    };
  if (signal?.aborted)
    info = {
      ...info,
      authenticated: false,
      commandLifecycle: false,
      models: [],
      executionModes: [],
      reason: 'Discovery was cancelled.',
    };
  return info;
}
