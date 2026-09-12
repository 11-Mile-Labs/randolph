import { useEffect, useRef, useState } from 'react';
import type { HarnessId, HarnessInfo, HarnessInstallation, Project, ProjectHarnessSettings } from '@randolph/runtime/contracts';

type Props = { project: Project; onClose: () => void; onChanged: () => Promise<void> };

export default function ProjectSettings({ project, onClose, onChanged }: Props) {
  const [settings, setSettings] = useState<ProjectHarnessSettings>(project.harnessSettings ?? { defaults: null, revision: null });
  const [harness, setHarness] = useState<HarnessInfo>();
  const [harnessId, setHarnessId] = useState<HarnessId>(settings.defaults?.harness ?? 'codex');
  const [installations, setInstallations] = useState<HarnessInstallation[]>([]);
  const [executable, setExecutable] = useState(settings.defaults?.executable ?? '');
  const [model, setModel] = useState(settings.defaults?.model ?? harness?.models[0]?.id ?? '');
  const [effort, setEffort] = useState(settings.defaults?.effort ?? harness?.models[0]?.defaultEffort ?? '');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestRef = useRef(0);
  const selectedModel = harness?.models.find(item => item.id === model);
  const valid = Boolean(harness?.available && harness.authenticated && selectedModel?.efforts.includes(effort));

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const request = ++requestRef.current;
    let disposed = false;
    void (async () => {
      try {
        const [copies, info] = await Promise.all([window.randolph.harnessInstallations(harnessId), window.randolph.harness(undefined, project.harnessSettings?.defaults?.executable ?? undefined, harnessId)]);
        if (disposed || request !== requestRef.current) return;
        setInstallations(copies); setHarness(info);
        setModel(project.harnessSettings?.defaults?.model ?? info.models[0]?.id ?? '');
        setEffort(project.harnessSettings?.defaults?.effort ?? info.models[0]?.defaultEffort ?? '');
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not inspect installed CLIs.'); }
      finally { if (!disposed) setBusy(false); }
    })();
    return () => { disposed = true; dialog?.close(); };
  }, []);

  const reload = async () => {
    setBusy(true); setError(undefined); setSaved(false);
    try {
      const snapshot = await window.randolph.snapshot();
      const next = snapshot.projects.find(item => item.id === project.id)?.harnessSettings;
      if (!next) throw new Error('Project settings are unavailable.');
      const selectedHarness = next.defaults?.harness ?? 'codex';
      const [copies, info] = await Promise.all([window.randolph.harnessInstallations(selectedHarness), window.randolph.harness(undefined, next.defaults?.executable ?? undefined, selectedHarness)]);
      setInstallations(copies); setHarness(info); setExecutable(next.defaults?.executable ?? '');
      setSettings(next); setHarnessId(selectedHarness);
      setModel(next.defaults?.model ?? info.models[0]?.id ?? '');
      setEffort(next.defaults?.effort ?? info.models[0]?.defaultEffort ?? '');
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reload project settings.'); }
    finally { setBusy(false); }
  };

  const chooseExecutable = async (path: string) => {
    const request = ++requestRef.current;
    setExecutable(path); setBusy(true); setSaved(false); setError(undefined); setHarness(undefined);
    try {
      const info = await window.randolph.harness(undefined, path || undefined, harnessId);
      if (request !== requestRef.current) return;
      setHarness(info); setModel(info.models[0]?.id ?? ''); setEffort(info.models[0]?.defaultEffort ?? '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not inspect this CLI.'); }
    finally { if (request === requestRef.current) setBusy(false); }
  };

  const chooseHarness = async (nextHarness: HarnessId) => {
    const request = ++requestRef.current;
    setHarnessId(nextHarness); setBusy(true); setSaved(false); setError(undefined); setHarness(undefined); setInstallations([]);
    try {
      const [copies, info] = await Promise.all([window.randolph.harnessInstallations(nextHarness), window.randolph.harness(undefined, undefined, nextHarness)]);
      if (request !== requestRef.current) return;
      setInstallations(copies); setHarness(info); setExecutable(''); setModel(info.models[0]?.id ?? ''); setEffort(info.models[0]?.defaultEffort ?? '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not inspect ${nextHarness}.`); }
    finally { if (request === requestRef.current) setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(undefined); setSaved(false);
    try {
      const next = await window.randolph.saveProjectDefaults({ projectId: project.id, defaults: { harness: harnessId, model, effort, executable: executable || null }, expectedRevision: settings.revision });
      setSettings(next); setSaved(true);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save project settings.'); }
    finally { setBusy(false); }
  };

  return (
    <dialog className="project-settings" ref={dialogRef} aria-labelledby="project-settings-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <header>
        <div><span className="eyebrow">{project.name}</span><h2 id="project-settings-title">Project settings</h2></div>
        <button className="secondary-button" type="button" disabled={busy} onClick={onClose} aria-label="Close settings">Close</button>
      </header>
      <p>Choose the defaults for conversations in this project. Conversation overrides take precedence. Changes apply to new runs; active runs keep their starting settings.</p>
      <div className="settings-fields">
        <label>Harness
          <select value={harnessId} disabled={busy} onChange={event => void chooseHarness(event.target.value as HarnessId)}>
            <option value="codex">Codex · ChatGPT subscription</option>
            <option value="grok">Grok · compatibility pending</option>
          </select>
        </label>
        <label>{harnessId === 'grok' ? 'Grok CLI' : 'Codex CLI'}
          <select value={executable} disabled={busy} onChange={event => void chooseExecutable(event.target.value)}>
            <option value="">Automatic discovery</option>
            {executable && !installations.some(item => item.executable === executable) ? <option value={executable}>{executable} (unavailable)</option> : null}
            {installations.map(item => <option key={item.executable} value={item.executable}>{item.version ?? 'Unavailable'} · {item.executable}</option>)}
          </select>
        </label>
        <p>{harness?.executable ? <><code>{harness.executable}</code><br />{harness.version} · {harness.executionModes?.includes('code') ? 'Read-only and Code' : harness.executionModes?.includes('read-only') ? 'Read-only; Code compatibility unverified' : 'Execution compatibility pending'}</> : harness?.reason ?? 'Checking the selected CLI…'}</p>
        {harness?.executionModes?.length === 0 && harness.reason ? <p>{harness.reason}</p> : null}
        <label>Default model
          <select value={model} disabled={busy || !harness?.available} onChange={event => {
            const next = harness?.models.find(item => item.id === event.target.value);
            if (next) { setModel(next.id); setEffort(next.defaultEffort); setSaved(false); }
          }}>
            {!selectedModel ? <option value={model}>{model ? `${model} (unavailable)` : 'No models available'}</option> : null}
            {harness?.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Default reasoning effort
          <select value={effort} disabled={busy || !selectedModel} onChange={event => { setEffort(event.target.value); setSaved(false); }}>
            {!selectedModel?.efforts.includes(effort) ? <option value={effort}>{effort ? `${effort} (unavailable)` : 'No effort available'}</option> : null}
            {selectedModel?.efforts.map(item => <option key={item} value={item}>{item} effort</option>)}
          </select>
        </label>
      </div>
      <p className="settings-location">Saving creates or updates <code>config.harness.yaml</code> in the project folder. You can version and edit this file yourself.</p>
      {settings.error ? <p className="inline-error" role="alert">{settings.error} Correct the file, then reload settings.</p> : null}
      {!valid && !settings.error ? <p className="inline-error">Choose an available model and effort before saving.</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {saved ? <p className="settings-saved" role="status">Project defaults saved.</p> : null}
      <footer>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void reload()}>Reload settings</button>
        <button className="primary-button" type="button" disabled={busy || !valid || Boolean(settings.error)} onClick={() => void save()}>{busy ? 'Working…' : 'Save project defaults'}</button>
      </footer>
    </dialog>
  );
}
