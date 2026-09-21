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
export const VERIFIED_CODE_VERSION = /^codex-cli 0\.(149|154)\.0$/;
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
