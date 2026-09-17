import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { HarnessInfo, HarnessInstallation, HarnessModel } from '@randolph/runtime/contracts';
import {
  object,
  text,
  VERIFIED_AGENT_VERSION,
  type GrokAdapterOptions,
  type Json,
} from './grok-shared.js';
import { AcpClient } from './grok-rpc.js';
import { candidates, GrokProcessHost, modelsFrom, terminate } from './grok-launch.js';

// Discovery recurses through the public adapter; the coordinator injects that re-entry so this
// module never imports the class it was cut from.
export type GrokRediscover = (executable: string, signal?: AbortSignal) => Promise<HarnessInfo>;

export class GrokAdmission {
  constructor(
    private options: GrokAdapterOptions,
    private host: GrokProcessHost,
    private timeout: number,
    private rediscover: GrokRediscover,
  ) {}
  checkProvider(model?: string): void {
    const read =
      this.options.readConfig ??
      ((path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined));
    for (const path of [
      join(homedir(), '.grok/config.toml'),
      join(homedir(), '.grok/managed_config.toml'),
      join(homedir(), '.grok/requirements.toml'),
      '/etc/grok/managed_config.toml',
      '/etc/grok/requirements.toml',
    ]) {
      const content = read(path);
      if (!content) continue;
      const config = parse(content) as Json;
      const selected = model ? object(object(config.model)[model]) : {};
      const endpoints = object(config.endpoints);
      if (
        [
          'api_key',
          'env_key',
          'base_url',
          'api_base_url',
          'extra_headers',
          'env_http_headers',
          'auth_provider',
          'model_provider',
          'mtls_cert_dir',
          'api_backend',
          'agent_type',
        ].some((key) => selected[key] !== undefined) ||
        (selected.model !== undefined && selected.model !== model) ||
        [
          'models_base_url',
          'xai_api_base_url',
          'cli_chat_proxy_base_url',
          'models_list_url',
          'models_endpoint',
          'managed_config_url',
        ].some((key) => endpoints[key] !== undefined)
      )
        throw new Error(
          'Custom Grok provider overrides are not supported by the subscription adapter.',
        );
    }
  }
  async initialize(client: AcpClient): Promise<{ models: HarnessModel[]; version: string }> {
    const result = await client.rpc('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'randolph', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    });
    const version = text(object(result._meta).agentVersion, 100);
    if (result.protocolVersion !== 1 || version !== VERIFIED_AGENT_VERSION)
      throw new Error('Grok returned an unverified ACP version.');
    const methods = Array.isArray(result.authMethods)
      ? result.authMethods.map((method) => object(method).id)
      : [];
    if (!methods.includes('cached_token') || methods.includes('xai.api_key'))
      throw new Error(
        'A native Grok subscription login is required; API authentication is refused.',
      );
    const auth = object(
      (await client.rpc('authenticate', { methodId: 'cached_token', _meta: { headless: true } }))
        ._meta,
    );
    if (auth.auth_mode !== 'Oidc' || auth.backend_billed !== false || !text(auth.subscription_tier))
      throw new Error(
        'Grok did not confirm subscription authentication with API billing disabled.',
      );
    return { models: modelsFrom(object(object(result._meta).modelState)), version };
  }
  async installations(): Promise<HarnessInstallation[]> {
    // Candidate enumeration must not launch a CLI outside discovery's cancellable lifecycle.
    return [
      ...new Set([...(this.options.executable ? [this.options.executable] : []), ...candidates()]),
    ].map((executable) => ({ executable }));
  }
  async discover(executable?: string, signal?: AbortSignal): Promise<HarnessInfo> {
    if (signal?.aborted)
      return {
        executable,
        available: false,
        authenticated: false,
        models: [],
        executionModes: [],
        cleanupVerified: true,
        reason: 'Discovery was cancelled before dispatch.',
      };
    if (executable !== undefined) return this.rediscover(executable, signal);
    let instance: ReturnType<GrokProcessHost['launch']> | undefined;
    let client: AcpClient | undefined;
    let stopping: Promise<boolean> | undefined;
    let selected: string | undefined;
    let info: HarnessInfo = {
      available: false,
      authenticated: false,
      models: [],
      executionModes: [],
      cleanupVerified: true,
    };
    const abort = (): void => {
      client?.fail(new Error('Discovery was cancelled.'));
      if (instance) stopping ??= terminate(instance.child);
    };
    try {
      selected = this.host.executable();
      this.checkProvider();
      instance = this.host.launch(homedir(), undefined, undefined, 'read-only', selected);
      client = new AcpClient(instance.child, this.timeout, () => {});
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const initialized = await this.initialize(client);
      if (signal?.aborted) throw new Error('Discovery was cancelled.');
      const version = `grok ${initialized.version}`;
      info = {
        executable: selected,
        version,
        available: true,
        authenticated: true,
        models: initialized.models,
        executionModes: [],
        cleanupVerified: false,
        reason:
          'Grok execution is unavailable: native tool and command boundaries are not yet verified.',
      };
    } catch (cause) {
      info = {
        executable: selected,
        available: Boolean(selected),
        authenticated: false,
        models: [],
        executionModes: [],
        cleanupVerified: true,
        reason: cause instanceof Error ? cause.message : 'Grok discovery failed.',
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      client?.fail(new Error('Discovery ended.'));
      if (instance) {
        info.cleanupVerified = await (stopping ?? terminate(instance.child));
        if (info.cleanupVerified) rmSync(instance.directory, { recursive: true, force: true });
      }
    }
    if (!info.cleanupVerified)
      info = {
        ...info,
        authenticated: false,
        models: [],
        executionModes: [],
        reason: 'Grok discovery cleanup could not be confirmed. Restart Randolph before retrying.',
      };
    if (signal?.aborted)
      info = {
        ...info,
        authenticated: false,
        models: [],
        executionModes: [],
        reason: 'Discovery was cancelled.',
      };
    return info;
  }
}
