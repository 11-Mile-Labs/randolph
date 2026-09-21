import { AdapterRunFailure } from './contracts.js';
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
  /** The shared native owner enforces dispatch deadlines and irrevocable cleanup settlement. */
  executorOwnsDeadlines?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: VerificationEvent) => void;
}

const OUTPUT_LIMIT = 256 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 5_000;

export { detectVerificationCommands } from './verification-command-discovery.js';

function emit(options: VerificationOptions, event: VerificationEvent): void {
  try {
    options.onEvent?.(event);
  } catch {
    /* Observers cannot interrupt execution or cleanup. */
  }
}

function cappedOutput(value: string, limit = OUTPUT_LIMIT): { output: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { output: value, truncated: false };
  // Streaming decode omits a partial final UTF-8 character instead of expanding it.
  return {
    output: new TextDecoder().decode(bytes.subarray(0, limit), { stream: true }),
    truncated: true,
  };
}

async function runCheck(
  workspace: string,
  command: CheckCommand,
  options: VerificationOptions,
): Promise<CheckResult> {
  const started = performance.now();
  const base: CheckResult = {
    command,
    status: 'failed',
    exitCode: null,
    output: '',
    truncated: false,
    elapsedMs: 0,
    cleanupVerified: true,
  };
  if (command.unsupportedReason)
    return { ...base, status: 'unavailable', error: command.unsupportedReason };
  if (typeof options.executor !== 'function')
    return {
      ...base,
      status: 'unavailable',
      error: 'A restricted verification executor is required.',
    };
  if (options.signal?.aborted) return { ...base, status: 'cancelled' };
  const controller = new AbortController();
  let timedOut = false;
  let streamed = '';
  let streamedBytes = 0;
  let streamedTruncated = false;
  let settled = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let abortFallback: (result: VerificationExecutionResult) => void = () => {};
  const abandoned = new Promise<VerificationExecutionResult>((resolve) => {
    abortFallback = resolve;
  });
  const cancel = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (!options.executorOwnsDeadlines)
      cleanupTimer = setTimeout(
        () =>
          abortFallback({
            exitCode: null,
            output: streamed,
            truncated: streamedTruncated,
            cleanupVerified: false,
            error: 'Verification executor did not confirm cleanup after cancellation.',
          }),
        CLEANUP_TIMEOUT_MS,
      );
  };
  const timer = options.executorOwnsDeadlines
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        cancel();
      }, COMMAND_TIMEOUT_MS);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const execution = (async () =>
      await options.executor(workspace, command, {
        signal: controller.signal,
        onOutput: (chunk) => {
          if (settled) return;
          const kept = cappedOutput(chunk, OUTPUT_LIMIT - streamedBytes);
          streamed += kept.output;
          streamedBytes += Buffer.byteLength(kept.output);
          streamedTruncated ||= kept.truncated;
          if (kept.output)
            emit(options, { type: 'check-output', checkId: command.id, output: kept.output });
        },
      }))();
    const result = options.executorOwnsDeadlines
      ? await execution
      : await Promise.race([execution, abandoned]);
    const output = cappedOutput(result.output || streamed);
    return {
      ...base,
      ...result,
      output: output.output,
      truncated: output.truncated || result.truncated || streamedTruncated,
      status: options.signal?.aborted
        ? 'cancelled'
        : timedOut || result.error || result.exitCode !== 0 || !result.cleanupVerified
          ? 'failed'
          : 'passed',
      elapsedMs: performance.now() - started,
      ...(timedOut
        ? { error: 'Verification exceeded the 10 minute command limit.' }
        : !result.cleanupVerified && !result.error
          ? { error: 'Verification process cleanup could not be confirmed.' }
          : {}),
    };
  } catch (error) {
    cancel();
    return {
      ...base,
      status: options.signal?.aborted ? 'cancelled' : 'failed',
      cleanupVerified: error instanceof AdapterRunFailure,
      output: streamed,
      truncated: streamedTruncated,
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    settled = true;
    clearTimeout(timer);
    clearTimeout(cleanupTimer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** Commands must come from detection, never from arbitrary IPC input. No host execution fallback exists. */
export async function runVerification(
  workspace: string,
  commands: CheckCommand[],
  options: VerificationOptions,
): Promise<VerificationResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const checks: CheckResult[] = [];
  let status: VerificationStatus = options.signal?.aborted
    ? 'cancelled'
    : commands.length
      ? 'passed'
      : 'unavailable';
  for (const command of commands) {
    if (options.signal?.aborted) {
      status = 'cancelled';
      break;
    }
    emit(options, { type: 'check-started', checkId: command.id });
    const result = await runCheck(workspace, command, options);
    checks.push(result);
    emit(options, { type: 'check-finished', checkId: command.id, result });
    if (result.status !== 'passed') {
      status = result.status;
      break;
    }
  }
  return {
    status,
    checks,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
  };
}
