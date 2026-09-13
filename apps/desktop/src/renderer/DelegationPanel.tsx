import { useEffect, useMemo, useState } from 'react';
import type { DelegationPlan, DelegationAssignment, DelegationRole, DelegationSnapshot, DelegationRevisionInput, ReviseDelegationInput, SaveDelegationPresetInput } from '@randolph/runtime/contracts';
import './DelegationPanel.css';

type Props = {
  snapshot: DelegationSnapshot;
  onRevise: (input: ReviseDelegationInput) => Promise<void>;
  onReject: (input: DelegationRevisionInput) => Promise<void>;
  onApprove: (input: DelegationRevisionInput) => Promise<void>;
  onSavePreset: (input: SaveDelegationPresetInput) => Promise<void>;
};

const roles: DelegationRole[] = ['worker', 'main-integration', 'runtime-verification', 'review', 'main-synthesis'];
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const clone = <T,>(value: T): T => structuredClone(value);
const rawLines = (value: string): string[] => value.split('\n');
const normalizedLines = (value: string[]): string[] => value.map(item => item.trim()).filter(Boolean);
const writeList = (value: string[]): string => value.join('\n');

function normalizedPlan(plan: DelegationPlan): DelegationPlan {
  return {
    ...plan,
    assignments: plan.assignments.map(assignment => {
      const { integrationInputs: rawIntegrationInputs, ...fields } = assignment;
      const integrationInputs = normalizedLines(rawIntegrationInputs ?? []);
      return {
        ...fields,
        dependencies: normalizedLines(assignment.dependencies),
        deliverables: normalizedLines(assignment.deliverables),
        completionCriteria: normalizedLines(assignment.completionCriteria),
        ...(integrationInputs.length ? { integrationInputs } : {}),
      };
    }),
  };
}

function emptyAssignment(index: number): DelegationAssignment {
  return { id: `assignment-${index + 1}`, task: '', role: 'worker', harness: 'codex', executable: '', executableVersion: '', model: '', effort: '', rationale: '', dependencies: [], source: 'run-basis', mode: 'read-only', deliverables: [''], completionCriteria: [''] };
}

function localErrors(plan: DelegationPlan): string[] {
  const normalized = normalizedPlan(plan);
  const errors: string[] = [];
  if (!normalized.assignments.length || normalized.assignments.length > 24) errors.push('Use between 1 and 24 assignments.');
  if (!normalized.limits.maxWorkers || !normalized.limits.maxParallel || !normalized.limits.maxAttempts || !normalized.limits.activeMinutes) errors.push('Every execution limit must be a positive whole number.');
  if (normalized.limits.maxParallel > normalized.limits.maxWorkers) errors.push('Parallel workers cannot exceed worker limit.');
  const ids = new Set<string>();
  for (const assignment of normalized.assignments) {
    if (!assignment.id || ids.has(assignment.id)) errors.push('Assignment IDs must be present and unique.');
    ids.add(assignment.id);
    if (![assignment.task, assignment.executable, assignment.executableVersion, assignment.model, assignment.effort, assignment.rationale, assignment.source].every(value => value.trim())) errors.push(`${assignment.id || 'Assignment'} has incomplete execution settings.`);
    if (!assignment.deliverables.length || !assignment.completionCriteria.length) errors.push(`${assignment.id || 'Assignment'} needs deliverables and completion criteria.`);
  }
  return [...new Set(errors)];
}

export default function DelegationPanel({ snapshot, onRevise, onReject, onApprove, onSavePreset }: Props) {
  const revision = snapshot.plan;
  const [draft, setDraft] = useState<DelegationPlan | undefined>(() => revision ? clone(revision.plan) : undefined);
  const [awaitingPlanId, setAwaitingPlanId] = useState<string>();
  const [busy, setBusy] = useState<'save' | 'reject' | 'approve' | 'preset'>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');

  useEffect(() => {
    setDraft(revision ? clone(revision.plan) : undefined);
    setError(undefined);
    setSaved(undefined);
  }, [revision?.id]);

  const awaitingRevisionRefresh = awaitingPlanId === revision?.id;
  const dirty = Boolean(revision && draft && !same(draft, revision.plan));
  const errors = useMemo(() => draft ? localErrors(draft) : [], [draft]);
  const revisionInput = revision ? { runId: snapshot.runId, planId: revision.id, digest: revision.digest, basisDigest: revision.basisDigest } : undefined;
  const blocked = [...snapshot.blockedReasons, ...snapshot.validationErrors, ...errors];
  const canApprove = Boolean(revisionInput && snapshot.canApprove && !dirty && !awaitingRevisionRefresh && !errors.length && !snapshot.validationErrors.length && !snapshot.blockedReasons.length);
  const canDecide = snapshot.canEdit && ['draft', 'ready'].includes(revision?.disposition ?? '');

  const updateAssignment = (index: number, value: Partial<DelegationAssignment>) => setDraft(current => current ? { ...current, assignments: current.assignments.map((assignment, item) => item === index ? { ...assignment, ...value } : assignment) } : current);
  const perform = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind); setError(undefined); setSaved(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Delegation action could not be completed.'); }
    finally { setBusy(undefined); }
  };

  if (!revision || !draft || !revisionInput) return null;

  const saveRevision = () => void perform('save', async () => {
    setAwaitingPlanId(revision.id);
    try {
      await onRevise({ ...revisionInput, plan: normalizedPlan(draft) });
      setSaved('Revision saved. The retained revision refreshes before it can be authorized.');
    } catch (cause) {
      setAwaitingPlanId(undefined);
      throw cause;
    }
  });
  const savePreset = () => void perform('preset', async () => {
    if (!presetId.trim() || !presetName.trim()) throw new Error('Preset ID and name are required.');
    await onSavePreset({ ...revisionInput, presetId: presetId.trim(), name: presetName.trim(), expectedSettingsRevision: snapshot.settings.revision });
    setSaved('Preset saved. Saving a preset does not authorize execution.');
  });

  return <section className="delegation-panel" aria-labelledby="delegation-title">
    <header className="delegation-header">
      <div><span className="eyebrow">Controlled delegation</span><h3 id="delegation-title">Plan revision {revision.revision}</h3><p>{revision.source === 'preset' ? 'Preset-derived plan' : 'Main-agent proposal'} · <code>{revision.digest.slice(0, 12)}</code></p></div>
      <span className={`delegation-disposition disposition-${revision.disposition}`}>{revision.disposition}</span>
    </header>
    <p className="delegation-copy">Review the exact harness, CLI, version, model, and effort for every assignment. Saving a revision and authorizing it are separate actions.</p>
    <details className="delegation-basis"><summary>Source and approval basis</summary><dl><dt>Plan digest</dt><dd><code>{revision.digest}</code></dd><dt>Basis digest</dt><dd><code>{revision.basisDigest}</code></dd></dl><pre>{JSON.stringify(revision.basis, null, 2)}</pre></details>

    <fieldset className="delegation-limits" disabled={Boolean(busy) || !snapshot.canEdit}>
      <legend>Execution limits</legend>
      {([['maxWorkers', 'Maximum workers'], ['maxParallel', 'Maximum parallel'], ['maxAttempts', 'Maximum attempts'], ['activeMinutes', 'Active minutes']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min="1" value={draft.limits[key]} onChange={event => setDraft(current => current ? { ...current, limits: { ...current.limits, [key]: Number(event.target.value) } } : current)} /></label>)}
    </fieldset>

    <div className="delegation-assignments" aria-label="Delegation assignments">
      {draft.assignments.map((assignment, index) => <details key={index} className="delegation-assignment" open={index === 0}>
        <summary><span>{assignment.task || `Assignment ${index + 1}`}</span><small>{assignment.role} · {assignment.harness} · {assignment.model || 'model required'}</small></summary>
        <div className="delegation-fields">
          <label>Task<input aria-label={`Assignment ${index + 1} task`} value={assignment.task} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { task: event.target.value })} /></label>
          <label>Assignment ID<input aria-label={`Assignment ${index + 1} ID`} value={assignment.id} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { id: event.target.value })} /></label>
          <label>Role<select aria-label={`Assignment ${index + 1} role`} value={assignment.role} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { role: event.target.value as DelegationRole })}>{roles.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
          <label>Harness<select aria-label={`Assignment ${index + 1} harness`} value={assignment.harness} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { harness: event.target.value as DelegationAssignment['harness'] })}><option value="codex">Codex</option><option value="grok">Grok</option></select></label>
          <label>CLI<input aria-label={`Assignment ${index + 1} CLI`} value={assignment.executable} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { executable: event.target.value })} /></label>
          <label>CLI version<input aria-label={`Assignment ${index + 1} CLI version`} value={assignment.executableVersion} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { executableVersion: event.target.value })} /></label>
          <label>Model<input aria-label={`Assignment ${index + 1} model`} value={assignment.model} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { model: event.target.value })} /></label>
          <label>Reasoning effort<input aria-label={`Assignment ${index + 1} effort`} value={assignment.effort} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { effort: event.target.value })} /></label>
          <label>Mode<select aria-label={`Assignment ${index + 1} mode`} value={assignment.mode} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { mode: event.target.value as DelegationAssignment['mode'] })}><option value="read-only">Read-only</option><option value="code">Code</option></select></label>
          <label>Source<input aria-label={`Assignment ${index + 1} source`} value={assignment.source} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { source: event.target.value as DelegationAssignment['source'] })} /></label>
          <label className="delegation-wide">Rationale<textarea aria-label={`Assignment ${index + 1} rationale`} rows={2} value={assignment.rationale} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { rationale: event.target.value })} /></label>
          <label>Dependencies<textarea aria-label={`Assignment ${index + 1} dependencies`} rows={2} value={writeList(assignment.dependencies)} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { dependencies: rawLines(event.target.value) })} /></label>
          <label>Integration inputs<textarea aria-label={`Assignment ${index + 1} integration inputs`} rows={2} value={writeList(assignment.integrationInputs ?? [])} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { integrationInputs: rawLines(event.target.value) })} /></label>
          <label>Deliverables<textarea aria-label={`Assignment ${index + 1} deliverables`} rows={3} value={writeList(assignment.deliverables)} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { deliverables: rawLines(event.target.value) })} /></label>
          <label>Completion criteria<textarea aria-label={`Assignment ${index + 1} completion criteria`} rows={3} value={writeList(assignment.completionCriteria)} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { completionCriteria: rawLines(event.target.value) })} /></label>
          <label>Repair attempts<input aria-label={`Assignment ${index + 1} repair attempts`} type="number" min="0" value={assignment.repairAttempts ?? 0} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { repairAttempts: Number(event.target.value) })} /></label>
          <label className="delegation-checkbox"><input aria-label={`Assignment ${index + 1} produces source`} type="checkbox" checked={Boolean(assignment.producesSource)} disabled={Boolean(busy) || !snapshot.canEdit} onChange={event => updateAssignment(index, { producesSource: event.target.checked })} />Produces immutable source</label>
        </div>
        <button className="secondary-button" type="button" disabled={Boolean(busy) || !snapshot.canEdit || draft.assignments.length === 1} onClick={() => setDraft(current => current ? { ...current, assignments: current.assignments.filter((_, item) => item !== index) } : current)}>Remove assignment</button>
      </details>)}
      <button className="secondary-button" type="button" disabled={Boolean(busy) || !snapshot.canEdit || draft.assignments.length >= 24} onClick={() => setDraft(current => current ? { ...current, assignments: [...current.assignments, emptyAssignment(current.assignments.length)] } : current)}>Add assignment</button>
    </div>

    {blocked.length ? <section className="delegation-blocked" aria-label="Approval blockers"><strong>Approval is blocked</strong><ul>{blocked.map(reason => <li key={reason}>{reason}</li>)}</ul></section> : null}
    {awaitingRevisionRefresh ? <p className="delegation-awaiting" role="status">The saved revision must refresh before it can be authorized.</p> : null}
    {(error || snapshot.settings.error) ? <p className="inline-error" role="alert">{error || snapshot.settings.error}</p> : null}
    {saved ? <p className="delegation-saved" role="status">{saved}</p> : null}

    <section className="delegation-preset" aria-label="Save named preset"><h4>Save a named preset</h4><p>Saving retains this exact revision for later selection. It does not authorize execution.</p>{snapshot.presetSaveWarnings?.length ? <aside className="delegation-preset-warning" aria-label="Preset save recovery warnings"><strong>Preset save needs review</strong><ul>{snapshot.presetSaveWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul></aside> : null}<label>Preset ID<input aria-label="Preset ID" value={presetId} disabled={Boolean(busy) || !canDecide} onChange={event => setPresetId(event.target.value)} /></label><label>Preset name<input aria-label="Preset name" value={presetName} disabled={Boolean(busy) || !canDecide} onChange={event => setPresetName(event.target.value)} /></label><button className="secondary-button" type="button" disabled={Boolean(busy) || !canDecide || dirty || awaitingRevisionRefresh || !presetId.trim() || !presetName.trim()} onClick={savePreset}>{busy === 'preset' ? 'Saving preset…' : 'Save preset'}</button></section>

    <section className="delegation-history" aria-label="Plan revision history"><h4>Retained revisions and tasks</h4><ul>{snapshot.history.map(item => <li key={item.id}><code>r{item.revision}</code> · {item.disposition} · {new Date(item.createdAt).toLocaleString()}</li>)}</ul><div>{snapshot.tasks.length ? snapshot.tasks.map(task => <span className={`delegation-task task-${task.state}`} key={task.id}>{task.assignmentId}: {task.state}</span>) : <span className="muted-copy">No authorized task graph yet.</span>}</div></section>

    <footer className="delegation-actions"><button className="secondary-button" type="button" disabled={Boolean(busy) || !snapshot.canEdit || !dirty || errors.length > 0} onClick={saveRevision}>{busy === 'save' ? 'Saving revision…' : 'Save revision'}</button><button className="secondary-button" type="button" disabled={Boolean(busy) || !canDecide} onClick={() => void perform('reject', () => onReject(revisionInput))}>{busy === 'reject' ? 'Rejecting…' : 'Reject plan'}</button><button className="primary-button" type="button" disabled={Boolean(busy) || !canApprove} onClick={() => void perform('approve', () => onApprove(revisionInput))}>{busy === 'approve' ? 'Authorizing…' : 'Authorize exact plan'}</button></footer>
  </section>;
}
