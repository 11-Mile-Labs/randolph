import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PushOptions } from './push-types.js';

export class CleanupUnconfirmedError extends Error {}
const LIMIT = 64 * 1024;

function environment(options: PushOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
  };
  if (options.sshKeyPath) {
    if (!isAbsolute(options.sshKeyPath) || /[\0\r\n]/.test(options.sshKeyPath))
      throw new Error('Configure an absolute unattended SSH identity path.');
    const quoted = "'" + options.sshKeyPath.replaceAll("'", "'\\''") + "'";
    env.GIT_SSH_COMMAND = `/usr/bin/ssh -F /dev/null -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -i ${quoted}`;
    env.GIT_SSH_VARIANT = 'ssh';
  }
  return env;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
async function cleanup(pid: number | undefined): Promise<boolean> {
  if (!pid || !groupAlive(pid)) return true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* Confirm below. */
  }
  await delay(100);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* Confirm below. */
    }
  }
  for (let count = 0; count < 40 && groupAlive(pid); count++) await delay(25);
  return !groupAlive(pid);
}

function assertCurrent(options: PushOptions): void {
  const result: unknown = options.assertCurrent?.();
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {
      /* Async guards cannot authorize a spawn. */
    });
    throw new Error('Push authority guards must be synchronous.');
  }
}
export async function git(
  root: string,
  args: string[],
  options: PushOptions,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; output: string }> {
  if (process.platform === 'win32') throw new Error('Origin push requires a POSIX host.');
  options.signal?.throwIfAborted();
  assertCurrent(options);
  options.signal?.throwIfAborted();
  const env = { ...environment(options), ...extraEnv };
  return await new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'credential.helper=',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.ssh.allow=always',
        '-c',
        `protocol.file.allow=${options.allowLocalTransport ? 'always' : 'never'}`,
        '-C',
        root,
        ...args,
      ],
      { env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let errorOutput = '';
    let bytes = 0;
    let failure: string | undefined;
    let finished = false;
    let shutdown: Promise<boolean> | undefined;
    const stop = (): Promise<boolean> => (shutdown ??= cleanup(child.pid));
    const abort = (): void => {
      failure = 'Origin operation cancelled; remote outcome may require reconciliation.';
      void stop();
    };
    const timer = setTimeout(() => {
      failure = 'Origin operation exceeded its 30 second limit.';
      void stop();
    }, 30_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const capture = (chunk: Buffer, stderr: boolean): void => {
      bytes += chunk.length;
      if (bytes > LIMIT) {
        failure = 'Origin operation output exceeded 64 KiB.';
        void stop();
        return;
      }
      if (stderr) errorOutput += chunk.toString('utf8');
      else output += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => capture(chunk, false));
    child.stderr.on('data', (chunk) => capture(chunk, true));
    const finish = async (code: number | null, error?: Error): Promise<void> => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      const confirmed = await stop();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!confirmed)
        reject(
          new CleanupUnconfirmedError('Origin operation process cleanup could not be confirmed.'),
        );
      else if (failure || error || code === null)
        reject(new Error(failure ?? error?.message ?? 'Origin operation exited unexpectedly.'));
      else resolve({ code, output: code ? errorOutput.trim().slice(0, 2000) : output.trim() });
    };
    child.once('error', (error) => {
      void finish(null, error);
    });
    child.once('exit', (code) => {
      void finish(code);
    });
  });
}
export async function requiredGit(
  root: string,
  args: string[],
  options: PushOptions,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await git(root, args, options, env);
  if (result.code !== 0)
    throw new Error(`Git origin operation failed (${result.code}): ${result.output}`);
  return result.output;
}
