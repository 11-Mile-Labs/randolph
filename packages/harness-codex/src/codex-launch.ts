import { accessSync, constants, statSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HarnessModel } from '@randolph/runtime/contracts';
import { hasOwn, identity, identitiesAgree, object, type Json } from './codex-shared.js';

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
