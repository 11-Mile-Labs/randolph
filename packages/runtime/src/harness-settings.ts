import { isAbsolute } from 'node:path';
import { readYamlSettings, writeYamlSettings } from './yaml-settings.js';
import type { HarnessId } from './contracts.js';

export type HarnessDefaults = { harness: HarnessId; model: string; effort: string; executable?: string | null };
export type HarnessSettings = { revision: string | null; defaults: HarnessDefaults | null; error?: string };

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

export function readHarnessSettings(root: string): HarnessSettings {
  const result = readYamlSettings(root, 'config.harness.yaml', validateDefaults, null);
  return { revision: result.revision, defaults: result.value, ...(result.error ? { error: result.error } : {}) };
}
export function writeHarnessSettings(root: string, defaults: HarnessDefaults, expectedRevision: string | null): HarnessSettings {
  const result = writeYamlSettings(root, 'config.harness.yaml', defaults, expectedRevision, validateDefaults);
  return { revision: result.revision, defaults: result.value, ...(result.error ? { error: result.error } : {}) };
}
