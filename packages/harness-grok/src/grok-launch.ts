import { accessSync, constants } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { HarnessModel } from '@randolph/runtime/contracts';
import { object, text, type Json } from './grok-shared.js';

export function environment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  );
  return {
    ...env,
    GROK_DISABLE_API_KEY_AUTH: '1',
    GROK_SUBAGENTS: '0',
    GROK_WORKFLOWS: '0',
    GROK_BACKEND_SEARCH: '0',
    GROK_WEB_FETCH: '0',
    GROK_MEMORY: '0',
    GROK_SESSION_SEARCH: '0',
    GROK_CAMPAIGNS: '0',
    GROK_MANAGED_MCPS_ENABLED: '0',
  };
}
export function candidates(): string[] {
  return [
    ...new Set([
      ...(process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((path) => join(path, 'grok')),
      join(homedir(), '.local/bin/grok'),
      join(homedir(), '.grok/bin/grok'),
      '/opt/homebrew/bin/grok',
    ]),
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
  if (!Array.isArray(value.availableModels))
    throw new Error('Grok returned no supported model catalog.');
  return value.availableModels.flatMap((entry) => {
    const model = object(entry);
    const meta = object(model._meta);
    const choices = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.map(object) : [];
    const efforts = choices.map((option) => text(option.id, 32)).filter(Boolean);
    const id = text(model.modelId, 200);
    return id && efforts.length
      ? [
          {
            id,
            name: text(model.name, 200) || id,
            efforts,
            defaultEffort:
              text(choices.find((option) => option.default === true)?.id, 32) || efforts[0]!,
          },
        ]
      : [];
  });
}
export async function terminate(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
        try {
          child.kill(name);
        } catch {
          /* Checked below. */
        }
      }
    }
  };
  signal('SIGTERM');
  for (let i = 0; i < 25 && !exited(); i++) await delay(20);
  signal('SIGKILL');
  for (let i = 0; i < 25 && !exited(); i++) await delay(20);
  if (!exited()) return false;
  try {
    if (child.pid) process.kill(-child.pid, 0);
    else return true;
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
