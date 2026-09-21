import { useEffect, useState } from 'react';
import type {
  AppSettingsSnapshot,
  HarnessInfo,
  WorkspaceSnapshot,
} from '@randolph/runtime/contracts';

type Props = {
  settings?: AppSettingsSnapshot;
  harness?: HarnessInfo;
  snapshot: WorkspaceSnapshot;
  onReload: () => Promise<void>;
  onSaved: (next: AppSettingsSnapshot) => void;
};

export default function AppSettings({ settings, harness, snapshot, onReload, onSaved }: Props) {
  const [value, setValue] = useState<AppSettingsSnapshot['value']>();
  const [autoApprove, setAutoApprove] = useState(false);
  const [busy, setBusy] = useState<'app' | 'memory'>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (settings) setValue(settings.value);
  }, [settings?.revision]);
  useEffect(() => {
    if (settings) setAutoApprove(settings.globalMemory.value.autoApprove);
  }, [settings?.globalMemory.revision]);
  if (!settings || !value)
    return (
      <section className="settings-screen" aria-labelledby="settings-title">
        <span className="eyebrow">Application</span>
        <h1 id="settings-title">Settings</h1>
        <p role="status">Loading settings…</p>
      </section>
    );
  const saveApp = async () => {
    setBusy('app');
    setError(undefined);
    setSaved(undefined);
    try {
      const next = await window.randolph.saveAppSettings({
        value,
        expectedRevision: settings.revision,
      });
      onSaved(next);
      setSaved('Application settings saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save application settings.');
    } finally {
      setBusy(undefined);
    }
  };
  const saveMemory = async () => {
    setBusy('memory');
    setError(undefined);
    setSaved(undefined);
    try {
      const next = await window.randolph.saveGlobalMemory({
        autoApprove,
        expectedRevision: settings.globalMemory.revision,
      });
      onSaved(next);
      setSaved('Global lesson policy saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save global lesson policy.');
    } finally {
      setBusy(undefined);
    }
  };
  const reload = async () => {
    setError(undefined);
    setSaved(undefined);
    try {
      await onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reload settings.');
    }
  };
  return (
    <section className="settings-screen" aria-labelledby="settings-title">
      <header>
        <div>
          <span className="eyebrow">Application</span>
          <h1 id="settings-title">Settings</h1>
          <p>Preferences are stored locally and apply to future app activity.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void reload()}
          disabled={Boolean(busy)}
        >
          Reload settings
        </button>
      </header>
      {error || settings.error || settings.globalMemory.error ? (
        <p className="inline-error" role="alert">
          {error || settings.error || settings.globalMemory.error}
        </p>
      ) : null}
      {saved ? (
        <p className="settings-saved" role="status">
          {saved}
        </p>
      ) : null}
      <section className="settings-section">
        <h2>Appearance</h2>
        <fieldset>
          <legend>Theme</legend>
          {(['system', 'light', 'dark'] as const).map((theme) => (
            <label key={theme}>
              <input
                type="radio"
                name="theme"
                checked={value.theme === theme}
                onChange={() => setValue((current) => (current ? { ...current, theme } : current))}
                disabled={Boolean(busy)}
              />
              {theme[0]!.toUpperCase() + theme.slice(1)}
            </label>
          ))}
        </fieldset>
      </section>
      <section className="settings-section">
        <h2>Background execution</h2>
        <label>
          <input
            type="checkbox"
            checked={value.background}
            onChange={(event) =>
              setValue((current) =>
                current ? { ...current, background: event.target.checked } : current,
              )
            }
            disabled={Boolean(busy)}
          />
          Keep app-managed work running when the window closes
        </label>
        <p>This does not restart stopped or interrupted work.</p>
      </section>
      <section className="settings-section">
        <h2>Notifications</h2>
        {(
          [
            ['completed', 'Completed runs'],
            ['failures', 'Failures'],
            ['approvals', 'Approvals needed'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={value.notifications[key]}
              onChange={(event) =>
                setValue((current) =>
                  current
                    ? {
                        ...current,
                        notifications: { ...current.notifications, [key]: event.target.checked },
                      }
                    : current,
                )
              }
              disabled={Boolean(busy)}
            />
            {label}
          </label>
        ))}
        <button
          className="primary-button"
          type="button"
          disabled={Boolean(busy) || Boolean(settings.error)}
          onClick={() => void saveApp()}
        >
          {busy === 'app' ? 'Saving…' : 'Save app settings'}
        </button>
      </section>
      <section className="settings-section">
        <h2>Global lesson approval</h2>
        <label>
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(event) => setAutoApprove(event.target.checked)}
            disabled={Boolean(busy)}
          />
          Automatically approve new global lessons
        </label>
        <p>Project lesson approval stays in each project’s Memory view.</p>
        <button
          className="primary-button"
          type="button"
          disabled={Boolean(busy) || Boolean(settings.globalMemory.error)}
          onClick={() => void saveMemory()}
        >
          {busy === 'memory' ? 'Saving…' : 'Save global lesson policy'}
        </button>
      </section>
      <section className="settings-section">
        <h2>Harness readiness</h2>
        <p>
          {harness?.available && harness.authenticated
            ? `Codex is ready${harness.version ? ` · ${harness.version}` : ''}.`
            : (harness?.reason ?? 'Checking the native harness…')}
        </p>
        {harness?.executable ? (
          <p>
            Automatically discovered CLI: <code>{harness.executable}</code>. Choose another
            installed copy in Project settings.
          </p>
        ) : null}
        <p>
          {harness?.models.length ?? 0} available model{harness?.models.length === 1 ? '' : 's'}.
        </p>
      </section>
      <section className="settings-section">
        <h2>Storage</h2>
        <p>Randolph stores history, evidence, and application settings locally.</p>
        <code>{snapshot.dataRoot || 'Storage path unavailable'}</code>
      </section>
    </section>
  );
}
