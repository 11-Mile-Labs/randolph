import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'smol-toml';
import type { HarnessModel } from '@randolph/runtime/contracts';
import {
  hasOwn,
  identity,
  identitiesAgree,
  object,
  type CodexAdapterOptions,
  type Exec,
  type Json,
  type Spawn,
} from './codex-shared.js';
import type { RpcClient } from './codex-rpc.js';

const THREAD_NOTIFICATIONS_WITH_TURN_ID = new Set(['thread/tokenUsage/updated']);

export function isRunScopedNotification(method: string): boolean {
  return method.startsWith('item/') || method.startsWith('turn/') || method.startsWith('thread/');
}
export function runNotificationIdentity(
  method: string,
  params: Json,
): { threadId: string; turnId?: string } | undefined {
  if (!isRunScopedNotification(method)) return undefined;
  const flatThreadId = identity(params.threadId);
  const thread = object(params.thread);
  const nestedThreadId = identity(thread.id);
  const flatTurnId = identity(params.turnId);
  const turn = object(params.turn);
  const nestedTurnId = identity(turn.id);
  if (
    (hasOwn(params, 'threadId') && !flatThreadId) ||
    (hasOwn(thread, 'id') && !nestedThreadId) ||
    (hasOwn(params, 'turnId') && !flatTurnId) ||
    (hasOwn(turn, 'id') && !nestedTurnId)
  )
    return undefined;
  if (method === 'thread/started') {
    return nestedThreadId && identitiesAgree(nestedThreadId, flatThreadId)
      ? { threadId: nestedThreadId }
      : undefined;
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    return flatThreadId &&
      nestedTurnId &&
      identitiesAgree(flatThreadId, nestedThreadId) &&
      identitiesAgree(nestedTurnId, flatTurnId)
      ? { threadId: flatThreadId, turnId: nestedTurnId }
      : undefined;
  }
  if (
    !flatThreadId ||
    !identitiesAgree(flatThreadId, nestedThreadId) ||
    !identitiesAgree(flatTurnId, nestedTurnId)
  )
    return undefined;
  if (flatTurnId) return { threadId: flatThreadId, turnId: flatTurnId };
  if (nestedTurnId) return undefined;
  if (
    method.startsWith('item/') ||
    method.startsWith('turn/') ||
    THREAD_NOTIFICATIONS_WITH_TURN_ID.has(method)
  )
    return undefined;
  return { threadId: flatThreadId };
}
export function workspacePolicy(workspace: string): Json {
  return {
    type: 'workspaceWrite',
    writableRoots: [workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}
export function verifyCodePolicy(thread: Json, workspace: string): void {
  const policy = object(thread.sandbox);
  // Verified Codex versions omit cwd from the additional writable roots in its response.
  const roots = policy.writableRoots;
  if (
    thread.cwd !== workspace ||
    thread.approvalPolicy !== 'never' ||
    policy.type !== 'workspaceWrite' ||
    policy.networkAccess !== false ||
    policy.excludeTmpdirEnvVar !== true ||
    policy.excludeSlashTmp !== true ||
    !Array.isArray(roots) ||
    roots.length > 1 ||
    (roots.length === 1 && roots[0] !== workspace)
  ) {
    throw new Error(
      'Codex effective permissions do not match the restricted workspace policy. Code dispatch refused.',
    );
  }
}
export const FEATURES = [
  'apps',
  'plugins',
  'hooks',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'remote_plugin',
  'shell_snapshot',
  'workspace_dependencies',
  'skill_search',
  'skill_mcp_dependency_install',
  'guardian_approval',
  'unbounded_connection_retries',
];
export function toolchainPath(): string {
  const directories = [
    join(homedir(), '.volta/bin'),
    ...(basename(process.execPath) === 'node' ? [dirname(process.execPath)] : []),
    join(homedir(), '.local/bin'),
    join(homedir(), '.pyenv/shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(directories)]
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .join(delimiter);
}
export function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key] as string]] : [],
    ),
  );
}
export function executableCandidates(): string[] {
  return [
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((path) => join(path, 'codex')),
    join(homedir(), '.codex/packages/standalone/current/bin/codex'),
    '/opt/homebrew/bin/codex',
    join(homedir(), '.volta/bin/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  ].filter((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
export function modelsFrom(value: Json): HarnessModel[] {
  if (!Array.isArray(value.data)) throw new Error('Codex returned an unsupported model list.');
  return value.data
    .map((item) => {
      const row = object(item);
      const efforts = Array.isArray(row.supportedReasoningEfforts)
        ? row.supportedReasoningEfforts
            .map((entry) => object(entry).reasoningEffort)
            .filter((entry): entry is string => typeof entry === 'string')
        : [];
      const defaultEffort =
        typeof row.defaultReasoningEffort === 'string' &&
        efforts.includes(row.defaultReasoningEffort)
          ? row.defaultReasoningEffort
          : (efforts[0] ?? '');
      return {
        id: String(row.model ?? row.id ?? ''),
        name: String(row.displayName ?? row.model ?? row.id ?? ''),
        efforts,
        defaultEffort,
      };
    })
    .filter((item) => item.id && item.efforts.length > 0);
}
export async function terminate(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try {
          child.kill(name);
        } catch {
          /* Unconfirmed below. */
        }
      }
    }
  };
  signal('SIGTERM');
  for (let count = 0; count < 15 && !exited(); count++) await delay(20);
  // Kill the owned process group even when its original leader has already exited.
  signal('SIGKILL');
  for (let count = 0; count < 15 && !exited(); count++) await delay(20);
  if (!exited()) return false;
  if (child.pid) {
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return true;
}
export class CodexProcessHost {
  readonly exec: Exec;
  readonly spawn: Spawn;
  readonly timeout: number;
  constructor(readonly options: CodexAdapterOptions = {}) {
    this.exec = options.execFile ?? ((file, args, settings) => execFileSync(file, args, settings));
    this.spawn = options.spawn ?? ((file, args, settings) => spawn(file, args, settings));
    this.timeout = options.rpcTimeoutMs ?? 20_000;
  }
  // Discovery re-enters with a substituted executable instead of reconstructing the public adapter.
  withExecutable(executable: string): CodexProcessHost {
    return new CodexProcessHost({ ...this.options, executable });
  }
  executablePath(): string {
    const path = this.options.executable ?? executableCandidates()[0];
    if (!path) throw new Error('Codex CLI was not found. Install it and sign in with ChatGPT.');
    return path;
  }
  launch(cwd: string, code = false): ChildProcessWithoutNullStreams {
    const configPath = join(homedir(), '.codex', 'config.toml');
    let config: Json = {};
    if (existsSync(configPath)) {
      try {
        config = parse(readFileSync(configPath, 'utf8')) as Json;
      } catch {
        throw new Error('Codex configuration could not be parsed. Check it in the CLI first.');
      }
    }
    const settings = [
      'model_provider="openai"',
      'forced_login_method="chatgpt"',
      `sandbox_mode="${code ? 'workspace-write' : 'read-only'}"`,
      'approval_policy="never"',
      'web_search="disabled"',
      'project_doc_max_bytes=0',
      'shell_environment_policy.inherit="none"',
      `shell_environment_policy.set.HOME=${JSON.stringify(cwd)}`,
      `shell_environment_policy.set.ZDOTDIR=${JSON.stringify(cwd)}`,
      `shell_environment_policy.set.PATH=${JSON.stringify(toolchainPath())}`,
      `shell_environment_policy.set.VOLTA_HOME=${JSON.stringify(join(homedir(), '.volta'))}`,
      `shell_environment_policy.set.PYENV_ROOT=${JSON.stringify(join(homedir(), '.pyenv'))}`,
      'shell_environment_policy.set.GIT_CONFIG_GLOBAL="/dev/null"',
      'shell_environment_policy.set.GIT_CONFIG_NOSYSTEM="1"',
    ];
    if (code)
      settings.push(
        'sandbox_workspace_write.network_access=false',
        'sandbox_workspace_write.exclude_tmpdir_env_var=true',
        'sandbox_workspace_write.exclude_slash_tmp=true',
        `sandbox_workspace_write.writable_roots=${JSON.stringify([cwd])}`,
      );
    for (const name of Object.keys(object(config.mcp_servers))) {
      if (!/^[A-Za-z0-9_-]+$/.test(name))
        throw new Error('This Codex configuration contains an unsupported MCP server name.');
      settings.push(`mcp_servers.${name}.enabled=false`);
    }
    return this.spawn(
      this.executablePath(),
      [
        'app-server',
        '--stdio',
        ...FEATURES.flatMap((feature) => ['--disable', feature]),
        ...settings.flatMap((setting) => ['-c', setting]),
      ],
      { cwd, env: environment(), stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );
  }
  async initialize(client: RpcClient): Promise<void> {
    await client.rpc('initialize', {
      clientInfo: { name: 'randolph', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    client.send({ method: 'initialized', params: {} });
  }
}
