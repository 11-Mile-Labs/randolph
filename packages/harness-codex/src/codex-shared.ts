import type { ChildProcessWithoutNullStreams } from 'node:child_process';
export type Json = Record<string, unknown>;
export type Exec = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; env: NodeJS.ProcessEnv },
) => string;
export type Spawn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    detached: boolean;
  },
) => ChildProcessWithoutNullStreams;
export type CodexAdapterOptions = {
  executable?: string;
  execFile?: Exec;
  spawn?: Spawn;
  rpcTimeoutMs?: number;
};
export type Pending = {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export const MAX_LINE = 1_048_576;
const CODEX_VERSION_PATTERN = /^codex-cli (\d+)\.(\d+)\.(\d+)$/;
const CODE_MODE_MIN_VERSION: [number, number, number] = [0, 149, 0];
const APPLICATION_TOOLS_MIN_VERSION: [number, number, number] = [0, 154, 0];
const parseCodexVersion = (version: string): [number, number, number] | undefined => {
  const match = CODEX_VERSION_PATTERN.exec(version);
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Components too large to compare exactly as numbers fail closed rather than risk
  // a wrong admit/reject decision from lost precision.
  if (!parts.every((part) => Number.isSafeInteger(part))) return undefined;
  return parts as [number, number, number];
};
const meetsMinVersion = (version: string, minimum: [number, number, number]): boolean => {
  const parsed = parseCodexVersion(version);
  if (!parsed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] > minimum[index]) return true;
    if (parsed[index] < minimum[index]) return false;
  }
  return true;
};
export const meetsCodeModeMinVersion = (version: string): boolean =>
  meetsMinVersion(version, CODE_MODE_MIN_VERSION);
export const meetsApplicationToolsMinVersion = (version: string): boolean =>
  meetsMinVersion(version, APPLICATION_TOOLS_MIN_VERSION);
export const bounded = (value: unknown, limit = 16_384): string =>
  typeof value === 'string' ? value.slice(0, limit) : '';
export const identity = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
export const identitiesAgree = (first: string | undefined, second: string | undefined): boolean =>
  !first || !second || first === second;
export const hasOwn = (value: Json, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
export const object = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
