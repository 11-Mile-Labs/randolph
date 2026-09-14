import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

export type ProcessIdentity = {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  start: string;
  zombie: boolean;
};
export type SignalResult = 'gone' | 'signalled' | 'identity-changed';

// The identity check and signal are separate syscalls; a process can exit or be
// reused in that gap. Callers must treat "signalled" as a request observation,
// not proof that the target stayed unchanged through delivery.

const parse = (output: string): ProcessIdentity[] => {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error('process snapshot is not an array');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid process identity');
    const item = entry as Record<string, unknown>;
    if (
      !['pid', 'ppid', 'pgid', 'uid'].every((key) => Number.isInteger(item[key])) ||
      typeof item.start !== 'string' ||
      typeof item.zombie !== 'boolean'
    )
      throw new Error('invalid process identity');
    return {
      pid: item.pid as number,
      ppid: item.ppid as number,
      pgid: item.pgid as number,
      uid: item.uid as number,
      start: item.start,
      zombie: item.zombie,
    };
  });
};

export function compileSnapshot(outputAbsolutePath: string): string {
  if (process.platform !== 'darwin') throw new Error('process identity helper requires macOS');
  if (!isAbsolute(outputAbsolutePath)) throw new Error('snapshot binary path must be absolute');
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/process-snapshot.c');
  execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', outputAbsolutePath], {
    timeout: 10000,
    stdio: 'pipe',
  });
  chmodSync(outputAbsolutePath, 0o755);
  return outputAbsolutePath;
}

export function snapshot(binary: string, pids?: number[]): ProcessIdentity[] {
  try {
    return parse(
      execFileSync(binary, pids?.map(String) ?? [], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    throw new Error(
      `process enumeration failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

export function sameIdentity(a: ProcessIdentity, b?: ProcessIdentity): boolean {
  if (!b) return false;
  return a.pid === b.pid && a.uid === b.uid && a.start === b.start;
}

export function identityAlive(processes: ProcessIdentity[], identity: ProcessIdentity): boolean {
  const current = processes.find((item) => item.pid === identity.pid);
  if (current) return sameIdentity(current, identity) && !current.zombie;
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('Retained process identity is unavailable');
  }
  throw new Error('Live retained process was omitted from enumeration');
}

export function descendants(
  processes: ProcessIdentity[],
  roots: ProcessIdentity[],
): ProcessIdentity[] {
  const validRoots = roots.filter((root) =>
    processes.some((process) => sameIdentity(process, root)),
  );
  const result: ProcessIdentity[] = [...validRoots];
  const seen = new Set(result.map((process) => process.pid));
  for (let cursor = 0; cursor < result.length; cursor++) {
    const parent = result[cursor];
    if (!parent) continue;
    for (const process of processes) {
      if (process.ppid === parent.pid && !seen.has(process.pid)) {
        seen.add(process.pid);
        result.push(process);
      }
    }
  }
  return result;
}

export function signalOwned(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
  binary: string,
): SignalResult {
  const current = snapshot(binary, [identity.pid]).find((process) => process.pid === identity.pid);
  if (!current) {
    identityAlive([], identity);
    return 'gone';
  }
  if (!sameIdentity(current, identity)) return 'identity-changed';
  try {
    process.kill(identity.pid, signal);
    return 'signalled';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    throw error;
  }
}
