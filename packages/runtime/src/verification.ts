import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export interface CheckCommand {
  id: string;
  label: string;
  command: string;
  args: string[];
  unsupportedReason?: string;
}
export type VerificationStatus = 'passed' | 'failed' | 'cancelled' | 'unavailable';
export interface CheckResult {
  command: CheckCommand;
  status: VerificationStatus;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  elapsedMs: number;
  cleanupVerified: boolean;
  error?: string;
}
export interface VerificationResult {
  status: VerificationStatus;
  checks: CheckResult[];
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
}
export interface VerificationEvent {
  type: 'check-started' | 'check-output' | 'check-finished';
  checkId: string;
  output?: string;
  result?: CheckResult;
}
export interface VerificationExecutionResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  cleanupVerified: boolean;
  error?: string;
}
/** The executor must enforce sandbox policy, literal argv, sanitized environment and descendant cleanup. */
export type VerificationExecutor = (
  workspace: string,
  command: CheckCommand,
  options: { signal: AbortSignal; onOutput: (chunk: string) => void },
) => Promise<VerificationExecutionResult>;
export interface VerificationOptions {
  executor: VerificationExecutor;
  signal?: AbortSignal;
  onEvent?: (event: VerificationEvent) => void;
}

const OUTPUT_LIMIT = 256 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 5_000;

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function manifest(workspace: string, name: string): Promise<string | undefined> {
  const directory = await lstat(workspace);
  if (!directory.isDirectory()) throw new Error('Verification workspace must be a directory without a symbolic link.');
  const path = join(workspace, name);
  let before;
  try { before = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile()) throw new Error(`${name} must be a regular manifest file without a symbolic link.`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || !sameFile(before, opened) || !sameFile(directory, await lstat(workspace))) throw new Error(`${name} changed while being opened.`);
    if (opened.size > 1024 * 1024) throw new Error(`${name} exceeds the 1 MiB manifest limit.`);
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > 1024 * 1024) throw new Error(`${name} exceeds the 1 MiB manifest limit.`);
    const after = await file.stat();
    const current = await lstat(path);
    if (!current.isFile() || !sameFile(opened, current) || !sameFile(directory, await lstat(workspace)) || before.size !== after.size || after.size !== total || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${name} changed while being read.`);
    return buffer.subarray(0, total).toString('utf8');
  } finally { await file.close(); }
}

async function hasFile(workspace: string, name: string): Promise<boolean> {
  try {
    const file = await lstat(join(workspace, name));
    if (!file.isFile()) throw new Error(`${name} must be a regular lockfile without a symbolic link.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function detectVerificationCommands(workspace: string): Promise<CheckCommand[]> {
  const commands: CheckCommand[] = [];
  const add = (id: string, command: string, args: string[]): void => { commands.push({ id, label: [command, ...args].join(' '), command, args }); };
  for (const name of ['package.json', 'go.mod', 'pyproject.toml']) {
    try {
      const source = await manifest(workspace, name);
      if (source === undefined) continue;
      if (name === 'package.json') {
        let value: unknown;
        try { value = JSON.parse(source); }
        catch { throw new Error('package.json is not valid JSON.'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package.json must be an object.');
        const { scripts, packageManager } = value as { scripts?: unknown; packageManager?: unknown };
        if (packageManager !== undefined && (typeof packageManager !== 'string' || !/^pnpm(?:@|$)/.test(packageManager))) {
          throw new Error('Only installed pnpm package-manager verification is supported.');
        }
        if (packageManager === undefined && !await hasFile(workspace, 'pnpm-lock.yaml') && (await hasFile(workspace, 'package-lock.json') || await hasFile(workspace, 'npm-shrinkwrap.json') || await hasFile(workspace, 'yarn.lock') || await hasFile(workspace, 'bun.lock') || await hasFile(workspace, 'bun.lockb'))) {
          throw new Error('This project declares a different package-manager lockfile; only installed pnpm verification is supported.');
        }
        if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
          for (const script of ['lint', 'typecheck', 'build', 'test']) {
            const content = (scripts as Record<string, unknown>)[script];
            if (typeof content === 'string' && content.trim()) add(`pnpm-${script}`, 'pnpm', ['run', script]);
          }
        }
      } else if (name === 'go.mod') {
        if (/^\s*module\s+\S+/m.test(source)) {
          for (const command of ['build', 'vet', 'test']) add(`go-${command}`, 'go', [command, './...']);
        } else { throw new Error('go.mod has no module declaration.'); }
      } else if (/^\s*\[tool\.pytest\.ini_options\]\s*(?:#.*)?$/m.test(source)) {
        add('python-pytest', 'python3', ['-m', 'pytest']);
      }
    } catch (error) {
      commands.push({ id: `unsupported-${name}`, label: `${name} verification unavailable`, command: '', args: [], unsupportedReason: error instanceof Error ? error.message : String(error) });
    }
  }
  return commands;
}

function emit(options: VerificationOptions, event: VerificationEvent): void {
  try { options.onEvent?.(event); }
  catch { /* Observers cannot interrupt execution or cleanup. */ }
}

function cappedOutput(value: string, limit = OUTPUT_LIMIT): { output: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { output: value, truncated: false };
  // Streaming decode omits a partial final UTF-8 character instead of expanding it.
  return { output: new TextDecoder().decode(bytes.subarray(0, limit), { stream: true }), truncated: true };
}

async function runCheck(workspace: string, command: CheckCommand, options: VerificationOptions): Promise<CheckResult> {
  const started = performance.now();
  const base: CheckResult = { command, status: 'failed', exitCode: null, output: '', truncated: false, elapsedMs: 0, cleanupVerified: true };
  if (command.unsupportedReason) return { ...base, status: 'unavailable', error: command.unsupportedReason };
  if (typeof options.executor !== 'function') return { ...base, status: 'unavailable', error: 'A restricted verification executor is required.' };
  if (options.signal?.aborted) return { ...base, status: 'cancelled' };
  const controller = new AbortController();
  let timedOut = false;
  let streamed = '';
  let streamedBytes = 0;
  let streamedTruncated = false;
  let settled = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let abortFallback: (result: VerificationExecutionResult) => void = () => {};
  const abandoned = new Promise<VerificationExecutionResult>(resolve => { abortFallback = resolve; });
  const cancel = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    cleanupTimer = setTimeout(() => abortFallback({ exitCode: null, output: streamed, truncated: streamedTruncated, cleanupVerified: false, error: 'Verification executor did not confirm cleanup after cancellation.' }), CLEANUP_TIMEOUT_MS);
  };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, COMMAND_TIMEOUT_MS);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const execution = (async () => await options.executor(workspace, command, {
      signal: controller.signal,
      onOutput: chunk => {
        if (settled) return;
        const kept = cappedOutput(chunk, OUTPUT_LIMIT - streamedBytes);
        streamed += kept.output;
        streamedBytes += Buffer.byteLength(kept.output);
        streamedTruncated ||= kept.truncated;
        if (kept.output) emit(options, { type: 'check-output', checkId: command.id, output: kept.output });
      },
    }))();
    const result = await Promise.race([execution, abandoned]);
    const output = cappedOutput(result.output || streamed);
    return {
      ...base, ...result, output: output.output, truncated: output.truncated || result.truncated || streamedTruncated,
      status: options.signal?.aborted ? 'cancelled' : timedOut || result.error || result.exitCode !== 0 || !result.cleanupVerified ? 'failed' : 'passed',
      elapsedMs: performance.now() - started,
      ...(timedOut ? { error: 'Verification exceeded the 10 minute command limit.' } : !result.cleanupVerified && !result.error ? { error: 'Verification process cleanup could not be confirmed.' } : {}),
    };
  } catch (error) {
    cancel();
    return { ...base, status: options.signal?.aborted ? 'cancelled' : 'failed', cleanupVerified: false, output: streamed, truncated: streamedTruncated, elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    settled = true;
    clearTimeout(timer);
    clearTimeout(cleanupTimer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** Commands must come from detection, never from arbitrary IPC input. No host execution fallback exists. */
export async function runVerification(workspace: string, commands: CheckCommand[], options: VerificationOptions): Promise<VerificationResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const checks: CheckResult[] = [];
  let status: VerificationStatus = options.signal?.aborted ? 'cancelled' : commands.length ? 'passed' : 'unavailable';
  for (const command of commands) {
    if (options.signal?.aborted) { status = 'cancelled'; break; }
    emit(options, { type: 'check-started', checkId: command.id });
    const result = await runCheck(workspace, command, options);
    checks.push(result);
    emit(options, { type: 'check-finished', checkId: command.id, result });
    if (result.status !== 'passed') { status = result.status; break; }
  }
  return { status, checks, startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started };
}
