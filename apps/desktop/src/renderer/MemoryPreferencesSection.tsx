import { useState } from 'react';
import type { MemorySnapshot } from '@randolph/runtime/contracts';
import { failure } from './memory-panel-types';

type Props = {
  projectSettings: MemorySnapshot['projectSettings'];
  globalAutoApprove: boolean;
  busy: boolean;
  onSaveProject: (value: MemorySnapshot['projectSettings']['value']) => Promise<unknown>;
  onSaveGlobal: (autoApprove: boolean) => void;
};

export default function MemoryPreferencesSection({
  projectSettings,
  globalAutoApprove,
  busy,
  onSaveProject,
  onSaveGlobal,
}: Props) {
  return (
    <details className="memory-preferences">
      <summary>Approval preferences and framework versions</summary>
      <p>
        Project and global auto-approval are separate. Changes apply to newly created or edited
        lessons.
      </p>
      <ProjectPreferences
        key={projectSettings.revision ?? 'default'}
        settings={projectSettings}
        busy={busy}
        save={onSaveProject}
      />
      <label>
        <input
          type="checkbox"
          checked={globalAutoApprove}
          disabled={busy}
          onChange={(event) => onSaveGlobal(event.target.checked)}
        />
        Automatically approve new global lessons
      </label>
    </details>
  );
}

function ProjectPreferences({
  settings,
  busy,
  save,
}: {
  settings: MemorySnapshot['projectSettings'];
  busy: boolean;
  save: (value: MemorySnapshot['projectSettings']['value']) => Promise<unknown>;
}) {
  const [autoApprove, setAutoApprove] = useState(settings.value.autoApprove);
  const [frameworks, setFrameworks] = useState(
    Object.entries(settings.value.frameworks)
      .map(([name, version]) => `${name}=${version}`)
      .join('\n'),
  );
  const [error, setError] = useState<string>();
  const submit = async () => {
    try {
      const entries = frameworks
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('=');
          if (separator < 1 || !line.slice(separator + 1).trim())
            throw new Error('Use one Framework=Version pair per line.');
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
        });
      if (new Set(entries.map(([name]) => name)).size !== entries.length)
        throw new Error('Framework names must be unique.');
      setError(undefined);
      await save({ autoApprove, frameworks: Object.fromEntries(entries) });
    } catch (error) {
      setError(failure(error));
    }
  };
  return (
    <div className="memory-project-preferences">
      <label>
        <input
          type="checkbox"
          checked={autoApprove}
          disabled={busy}
          onChange={(event) => setAutoApprove(event.target.checked)}
        />
        Automatically approve new project lessons
      </label>
      <label>
        Project framework versions
        <textarea
          aria-label="Project framework versions"
          rows={3}
          value={frameworks}
          onChange={(event) => setFrameworks(event.target.value)}
          placeholder="React=19"
        />
      </label>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="secondary-button" disabled={busy} onClick={() => void submit()}>
        Save project memory preferences
      </button>
    </div>
  );
}
