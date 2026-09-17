import type {
  AdapterCommand,
  AdapterRun,
  HarnessAdapter,
  HarnessInfo,
  HarnessInstallation,
} from '@randolph/runtime/contracts';
import { type CodexAdapterOptions } from './codex-shared.js';
import { CodexProcessHost } from './codex-launch.js';
import {
  discover as discoverCodex,
  installations as codexInstallations,
} from './codex-discovery.js';
import { runCommand as runCodexCommand } from './codex-command.js';
import { run as runCodexTurn } from './codex-turn.js';

export type { CodexAdapterOptions } from './codex-shared.js';

export class CodexAdapter implements HarnessAdapter {
  private readonly host: CodexProcessHost;
  constructor(private readonly options: CodexAdapterOptions = {}) {
    this.host = new CodexProcessHost(options);
  }
  async installations(): Promise<HarnessInstallation[]> {
    return codexInstallations(this.host);
  }
  async discover(executable?: string, signal?: AbortSignal): Promise<HarnessInfo> {
    return discoverCodex(this.host, executable, signal);
  }
  async runCommand(input: AdapterCommand): Promise<{
    exitCode: number | null;
    output: string;
    truncated: boolean;
    cleanupVerified: boolean;
    error?: string;
  }> {
    return runCodexCommand(this.host, input);
  }
  async run(
    input: AdapterRun,
  ): Promise<{ status: 'completed' | 'interrupted' | 'stop-unconfirmed' }> {
    return runCodexTurn(this.host, input);
  }
}
