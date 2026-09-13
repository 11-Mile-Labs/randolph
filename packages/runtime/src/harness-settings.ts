import { isAbsolute } from 'node:path';
import { readYamlSettings, writeYamlSettings } from './yaml-settings.js';
import type { HarnessId, HarnessRoute } from './contracts.js';

export type HarnessDefaults = { harness: HarnessId; model: string; effort: string; executable?: string | null };
export type HarnessSettings = { revision: string | null; defaults: HarnessDefaults | null; enabledRoutes?: HarnessRoute[]; error?: string };

export function validateHarnessRoutes(value: unknown): HarnessRoute[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Enabled routes must be a list of at most 32 harness CLIs.');
  const seen = new Set<string>();
  return value.map(route => {
    const validated = validateDefaults({ ...route, model: 'route', effort: 'route' });
    if (!validated.executable) throw new Error('Each enabled route requires an absolute CLI executable.');
    const key = `${validated.harness}:${validated.executable}`;
    if (seen.has(key)) throw new Error('Enabled CLI routes must be unique.');
    seen.add(key);
    return { harness: validated.harness, executable: validated.executable };
  });
}

export function assertHarnessRoute(settings: HarnessSettings, harness: HarnessId, executable?: string): void {
  if (settings.error) throw new Error(settings.error);
  if (settings.enabledRoutes && !settings.enabledRoutes.some(route => route.harness === harness && route.executable === executable)) {
    throw new Error('This harness CLI is not enabled for this project. Enable it in Project settings before starting work.');
  }
}

function validateDefaults(value: unknown): HarnessDefaults {
  if (!value || typeof value !== 'object') throw new Error('Harness settings must contain a model and effort.');
  const { harness, model, effort, executable } = value as Record<string, unknown>;
  const validText = (text: unknown, max: number): text is string => typeof text === 'string'
    && text.length > 0 && text.length <= max && text.trim() === text
    && !Array.from(text).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if ((harness !== 'codex' && harness !== 'grok') || !validText(model, 200) || !validText(effort, 32)) {
    throw new Error('Harness settings require a supported harness and nonempty, bounded model and effort names.');
  }
  if (executable !== undefined && executable !== null && (!validText(executable, 4096) || !isAbsolute(executable))) throw new Error('The CLI executable must be a bounded absolute path.');
  return { harness, model, effort, ...(executable === undefined ? {} : { executable }) };
}

function validateConfiguration(value: unknown): HarnessDefaults & { enabledRoutes?: HarnessRoute[] } {
  const defaults = validateDefaults(value);
  const routes = (value as Record<string, unknown>).enabledRoutes;
  return { ...defaults, ...(routes === undefined ? {} : { enabledRoutes: validateHarnessRoutes(routes) }) };
}
function snapshot(result: { revision: string | null; value: ReturnType<typeof validateConfiguration> | null; error?: string }): HarnessSettings {
  const { enabledRoutes, ...defaults } = result.value ?? {};
  return { revision: result.revision, defaults: result.value ? defaults as HarnessDefaults : null, ...(enabledRoutes === undefined ? {} : { enabledRoutes }), ...(result.error ? { error: result.error } : {}) };
}
export function readHarnessSettings(root: string): HarnessSettings {
  return snapshot(readYamlSettings(root, 'config.harness.yaml', validateConfiguration, null));
}
export function writeHarnessSettings(root: string, defaults: HarnessDefaults, expectedRevision: string | null, enabledRoutes?: HarnessRoute[]): HarnessSettings {
  const current = readHarnessSettings(root);
  const routes = enabledRoutes === undefined ? current.enabledRoutes : validateHarnessRoutes(enabledRoutes);
  const values = { ...defaults, ...(routes === undefined ? {} : { enabledRoutes: routes }) };
  return snapshot(writeYamlSettings(root, 'config.harness.yaml', values, expectedRevision, validateConfiguration));
}
