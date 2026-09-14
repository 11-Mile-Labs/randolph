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
export type Pending = {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export const VERIFIED_VERSION = 'grok 1.0.30 (04b7ffed98c6) [stable]';
export const VERIFIED_AGENT_VERSION = '1.0.30';
export const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
export const text = (value: unknown, limit = 16_384): string =>
  typeof value === 'string' ? value.slice(0, limit) : '';
export type GrokAdapterOptions = {
  executable?: string;
  execFile?: Exec;
  spawn?: Spawn;
  readConfig?: (path: string) => string | undefined;
  rpcTimeoutMs?: number;
};
