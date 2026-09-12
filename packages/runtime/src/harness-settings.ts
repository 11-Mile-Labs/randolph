import { readYamlSettings, writeYamlSettings } from './yaml-settings.js';

export type HarnessDefaults = { harness: 'codex'; model: string; effort: string };
export type HarnessSettings = { revision: string | null; defaults: HarnessDefaults | null; error?: string };

function validateDefaults(value: unknown): HarnessDefaults {
  if (!value || typeof value !== 'object') throw new Error('Harness settings must contain a model and effort.');
  const { harness, model, effort } = value as Record<string, unknown>;
  const validText = (text: unknown, max: number): text is string => typeof text === 'string'
    && text.length > 0 && text.length <= max && text.trim() === text
    && !Array.from(text).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (harness !== 'codex' || !validText(model, 200) || !validText(effort, 32)) {
    throw new Error('Harness settings require harness codex and nonempty, bounded model and effort names.');
  }
  return { harness, model, effort };
}

export function readHarnessSettings(root: string): HarnessSettings {
  const result = readYamlSettings(root, 'config.harness.yaml', validateDefaults, null);
  return { revision: result.revision, defaults: result.value, ...(result.error ? { error: result.error } : {}) };
}
export function writeHarnessSettings(root: string, defaults: HarnessDefaults, expectedRevision: string | null): HarnessSettings {
  const result = writeYamlSettings(root, 'config.harness.yaml', defaults, expectedRevision, validateDefaults);
  return { revision: result.revision, defaults: result.value, ...(result.error ? { error: result.error } : {}) };
}
