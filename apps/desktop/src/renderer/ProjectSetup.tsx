import { useEffect, useRef, useState } from 'react';
import type { HarnessId, HarnessInfo, HarnessInstallation, Project, ProjectContext, ProjectSetupSnapshot, Run, RunEvent } from '@randolph/runtime/contracts';

type Props = { project: Project; onClose: () => void; onChanged: () => Promise<void> };
const emptyContext: ProjectContext = { purpose: '', instructions: '', documents: [] };
const active = (status: Run['status']) => status === 'starting' || status === 'running' || status === 'stopping';

export default function ProjectSetup({ project, onClose, onChanged }: Props) {
  const [setup, setSetup] = useState<ProjectSetupSnapshot>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [draft, setDraft] = useState<ProjectContext>(emptyContext);
  const [brief, setBrief] = useState('');
  const [harnessId, setHarnessId] = useState<HarnessId>('codex');
  const [installations, setInstallations] = useState<HarnessInstallation[]>([]);
  const [harness, setHarness] = useState<HarnessInfo>();
  const [executable, setExecutable] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const draftDirtyRef = useRef(false);
  const draftRevisionRef = useRef<string | undefined>(undefined);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const latest = setup?.inspections.at(-1);
  const selectedModel = harness?.models.find(item => item.id === model);
  const selectedInspection = latest?.proposal?.value;
  const currentRun = latest?.run;
  const blockedRun = Boolean(currentRun && (active(currentRun.status) || currentRun.cleanupUnconfirmed || currentRun.status === 'stop-unconfirmed'));
  const canInspect = Boolean(!blockedRun && harness?.available && harness.authenticated && selectedModel && selectedModel.efforts.includes(effort) && harness?.executionModes?.includes('read-only'));

  const load = async (resetDraft = false) => {
    try {
      const next = await window.randolph.projectSetup(project.id);
      setSetup(next);
      const workspace = await window.randolph.snapshot();
      setEvents(workspace.events.filter(event => next.inspections.some(item => item.run.id === event.runId)).slice(-10));
      const nextRevision = next.inspections.at(-1)?.proposal?.revision;
      if (resetDraft || !draftDirtyRef.current) {
        setDraft(next.inspections.at(-1)?.proposal?.value.context ?? next.context.value);
        draftRevisionRef.current = nextRevision;
        draftDirtyRef.current = false;

      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load project setup.'); }
  };
  const loadHarness = async (nextHarness: HarnessId, nextExecutable?: string) => {
    setHarnessId(nextHarness); setBusy(true); setError(undefined);
    try {
      const [copies, info] = await Promise.all([window.randolph.harnessInstallations(nextHarness), window.randolph.harness(project.id, nextExecutable || undefined, nextHarness)]);
      setInstallations(copies); setHarness(info); setExecutable(nextExecutable ?? '');
      setModel(info.models[0]?.id ?? ''); setEffort(info.models[0]?.defaultEffort ?? '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not inspect the selected harness.'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    dialogRef.current?.showModal();
    void Promise.all([load(), loadHarness('codex')]);
    const unsubscribe = window.randolph.onChanged(() => { void load(); void onChanged(); });
    return () => { unsubscribe(); dialogRef.current?.close(); };
  }, []);

  const updateDraft = (value: ProjectContext) => { setDraft(value); draftDirtyRef.current = true; };
  const inspect = async () => {
    if (!canInspect) return;
    setBusy(true); setError(undefined);
    try { await window.randolph.inspectProject({ projectId: project.id, selection: { harness: harnessId, model, effort }, executable: executable || undefined, brief }); setBrief(''); await load(true); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Inspection could not start.'); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!latest?.proposal || !latest.canApprove || !currentRun?.projectContext) return;
    setBusy(true); setError(undefined);
    try { await window.randolph.approveProjectSetup({ projectId: project.id, runId: currentRun.id, proposalRevision: latest.proposal.revision, expectedContextRevision: currentRun.projectContext.revision, value: draft }); draftDirtyRef.current = false; await load(true); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Approval is stale. Reload the proposal and try again.'); }
    finally { setBusy(false); }
  };
  const stop = async () => { if (!currentRun) return; setBusy(true); try { await window.randolph.stop(currentRun.id); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not stop inspection.'); } finally { setBusy(false); } };
  const saveDefault = async () => {
    if (!harness || !selectedModel || !selectedModel.efforts.includes(effort)) return;
    setBusy(true); setError(undefined);
    try { await window.randolph.saveProjectDefaults({ projectId: project.id, defaults: { harness: harnessId, model, effort, executable: executable || null }, expectedRevision: project.harnessSettings?.revision ?? null }); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the selected agent as the project default.'); }
    finally { setBusy(false); }
  };
  return <dialog className="project-settings project-setup" ref={dialogRef} aria-labelledby="project-setup-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><span className="eyebrow">{project.name}</span><h2 id="project-setup-title">Project setup</h2></div><button className="secondary-button" type="button" onClick={onClose}>Close project setup</button></header>
    <p>Review the approved project context, then run a read-only inspection to propose updates. Opening this view never starts work.</p>
    <section className="setup-approved"><h3>Approved context</h3><p><strong>Purpose</strong><br />{setup?.context.value.purpose || 'No approved purpose yet.'}</p><p><strong>Instructions</strong><br />{setup?.context.value.instructions || 'No approved instructions yet.'}</p><p><strong>Documents</strong></p>{setup?.context.value.documents.length ? <ul>{setup.context.value.documents.map(doc => <li key={doc.path}><code>{doc.path}</code> — {doc.description}</li>)}</ul> : <p>No document references.</p>}<p>Revision <code>{setup?.context.revision ?? "none"}</code></p>{setup?.context.error ? <p className="inline-error" role="alert">{setup.context.error}</p> : null}</section>
    <section className="settings-fields"><label>Harness<select value={harnessId} disabled={busy} onChange={event => void loadHarness(event.target.value as HarnessId)}><option value="codex">Codex · checking availability</option><option value="grok">Grok · compatibility pending</option></select></label><label>CLI<select value={executable} disabled={busy} onChange={event => void loadHarness(harnessId, event.target.value)}><option value="">Automatic discovery</option>{installations.map(item => <option key={item.executable} value={item.executable}>{item.version ?? 'Unknown'} · {item.executable}</option>)}</select></label><label>Model<select value={model} disabled={busy || !harness?.available} onChange={event => { const item = harness?.models.find(value => value.id === event.target.value); setModel(item?.id ?? ''); setEffort(item?.defaultEffort ?? ''); }}><option value="">Choose a model</option>{harness?.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Reasoning effort<select value={effort} disabled={busy || !selectedModel} onChange={event => setEffort(event.target.value)}>{selectedModel?.efforts.map(item => <option key={item} value={item}>{item}</option>)}</select></label></section>
    {harness?.executionModes?.length === 0 ? <p className="inline-error" role="alert">{harness.reason ?? 'This harness is not verified for execution.'}</p> : null}
    <label className="setup-brief">Setup idea or corrections<textarea aria-label="Setup idea or corrections" value={brief} onChange={event => setBrief(event.target.value)} rows={3} placeholder="What should the inspection understand or correct?" /></label>
    {selectedInspection ? <section className="setup-proposal"><h3>Latest proposal {setup?.context.revision === latest?.proposal?.revision ? <span className="setup-ready">Approved</span> : latest?.canApprove ? <span className="setup-ready">Ready to approve</span> : <span>Needs another inspection</span>}</h3><label>Proposed purpose<input aria-label="Proposed purpose" value={draft.purpose} onChange={event => updateDraft({ ...draft, purpose: event.target.value })} /></label><label>Proposed instructions<textarea aria-label="Proposed instructions" value={draft.instructions} onChange={event => updateDraft({ ...draft, instructions: event.target.value })} rows={5} /></label><h4>Documents</h4>{draft.documents.map((doc, index) => <div className="setup-document" key={`${doc.path}-${index}`}><input aria-label={`Document ${index + 1} path`} value={doc.path} onChange={event => { const documents = [...draft.documents]; documents[index] = { ...doc, path: event.target.value }; updateDraft({ ...draft, documents }); }} /><input aria-label={`Document ${index + 1} description`} value={doc.description} onChange={event => { const documents = [...draft.documents]; documents[index] = { ...doc, description: event.target.value }; updateDraft({ ...draft, documents }); }} /><button className="secondary-button" type="button" onClick={() => updateDraft({ ...draft, documents: draft.documents.filter((_, item) => item !== index) })}>Remove</button></div>)}<button className="secondary-button" type="button" onClick={() => updateDraft({ ...draft, documents: [...draft.documents, { path: '', description: '' }] })}>Add document</button><h4>Evidence</h4><ul>{selectedInspection.evidence.map(item => <li key={item}>{item}</li>)}</ul><h4>Questions</h4><ul>{selectedInspection.questions.length ? selectedInspection.questions.map(item => <li key={item}>{item}</li>) : <li>None recorded.</li>}</ul></section> : <p className="muted-copy">No inspection proposal yet.</p>}
    {currentRun && active(currentRun.status) ? <div className="setup-activity" role="status"><strong>Inspection {currentRun.status}</strong><p>Native setup activity is being recorded in the Project setup conversation.</p><button className="secondary-button" type="button" onClick={() => void stop()} disabled={busy}>Stop inspection</button></div> : null}
    {events.length ? <section className="setup-events" aria-label="Inspection activity"><h4>Tool activity</h4><ul>{events.toReversed().map(event => <li key={`${event.runId}-${event.sequence}`}><strong>{event.summary}</strong> <small>{event.type}</small></li>)}</ul></section> : null}
    {latest?.error || error ? <p className="inline-error" role="alert">{error ?? latest?.error}</p> : null}
    <footer><button className="secondary-button" type="button" onClick={() => void load(true)} disabled={busy}>Reload</button><button className="secondary-button" type="button" onClick={() => void saveDefault()} disabled={busy || !canInspect}>Save selected agent as project default</button><button className="secondary-button" type="button" onClick={() => void inspect()} disabled={busy || !canInspect}>{busy ? 'Working…' : 'Inspect project'}</button><button className="primary-button" type="button" onClick={() => void approve()} disabled={busy || !latest?.canApprove || !draft.purpose.trim()}>Approve project context</button></footer>
  </dialog>;
}
