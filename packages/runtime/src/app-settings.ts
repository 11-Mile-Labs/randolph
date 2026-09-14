import { realpathSync } from 'node:fs';
import { readYamlSettings, writeYamlSettings } from './yaml-settings.js';
import { readMemorySettings, writeMemorySettings, type MemorySettings } from './memory-settings.js';

export type AppPreferences = {
  theme: 'system' | 'light' | 'dark';
  background: boolean;
  notifications: { completed: boolean; failures: boolean; approvals: boolean };
};
export type AppSettingsSnapshot = {
  revision: string | null;
  value: AppPreferences;
  error?: string;
  globalMemory: MemorySettings;
};
export type SaveAppSettingsInput = { value: AppPreferences; expectedRevision: string | null };
export type SaveGlobalMemoryInput = { autoApprove: boolean; expectedRevision: string | null };
const defaults: AppPreferences = {
  theme: 'system',
  background: false,
  notifications: { completed: false, failures: false, approvals: false },
};
export function validateAppPreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid application preferences.');
  const input = value as Record<string, unknown>;
  if (
    !['system', 'light', 'dark'].includes(String(input.theme)) ||
    typeof input.background !== 'boolean' ||
    !input.notifications ||
    typeof input.notifications !== 'object'
  )
    throw new Error('Invalid appearance or background preferences.');
  const notifications = input.notifications as Record<string, unknown>;
  if (['completed', 'failures', 'approvals'].some((key) => typeof notifications[key] !== 'boolean'))
    throw new Error('Invalid notification preferences.');
  return {
    theme: input.theme as AppPreferences['theme'],
    background: input.background,
    notifications: {
      completed: notifications.completed as boolean,
      failures: notifications.failures as boolean,
      approvals: notifications.approvals as boolean,
    },
  };
}
export class AppSettings {
  private readonly root: string;
  constructor(root: string) {
    this.root = realpathSync(root);
  }
  read(): AppSettingsSnapshot {
    return {
      ...readYamlSettings(
        this.root,
        'config.app.yaml',
        validateAppPreferences,
        structuredClone(defaults),
      ),
      globalMemory: readMemorySettings(this.root),
    };
  }
  save(input: SaveAppSettingsInput): AppSettingsSnapshot {
    writeYamlSettings(
      this.root,
      'config.app.yaml',
      input.value,
      input.expectedRevision,
      validateAppPreferences,
    );
    return this.read();
  }
  saveGlobalMemory(input: SaveGlobalMemoryInput): AppSettingsSnapshot {
    if (typeof input.autoApprove !== 'boolean')
      throw new Error('Invalid global lesson approval setting.');
    const previous = readMemorySettings(this.root);
    if (previous.error) throw new Error(previous.error);
    writeMemorySettings(
      this.root,
      { ...previous.value, autoApprove: input.autoApprove },
      input.expectedRevision,
    );
    return this.read();
  }
}
