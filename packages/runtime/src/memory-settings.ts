import { readYamlSettings, writeYamlSettings, type YamlSettings } from './yaml-settings.js';

export type MemoryPreferences = { autoApprove: boolean; frameworks: Record<string, string> };
export type MemorySettings = YamlSettings<MemoryPreferences>;
function validate(value: unknown): MemoryPreferences {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input.autoApprove !== 'boolean') throw new Error('Memory settings require autoApprove: true or false.');
  const frameworks = input.frameworks ?? {};
  if (typeof frameworks !== 'object' || !frameworks || Array.isArray(frameworks) || Object.keys(frameworks).length > 30) throw new Error('Invalid framework/version settings.');
  for (const [name, version] of Object.entries(frameworks)) {
    if (!name.trim() || name.length > 100 || typeof version !== 'string' || !version.trim() || version.length > 100 || Array.from(name + version).some(character => character.charCodeAt(0) < 32)) throw new Error('Framework names and versions must be bounded text.');
  }
  return { autoApprove: input.autoApprove, frameworks: frameworks as Record<string, string> };
}
export function readMemorySettings(root: string): MemorySettings {
  return readYamlSettings(root, 'config.memory.yaml', validate, { autoApprove: false, frameworks: {} });
}
export function writeMemorySettings(root: string, value: MemoryPreferences, expectedRevision: string | null): MemorySettings {
  return writeYamlSettings(root, 'config.memory.yaml', value, expectedRevision, validate);
}
