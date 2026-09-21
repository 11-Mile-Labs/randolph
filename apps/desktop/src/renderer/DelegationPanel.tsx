import { useEffect, useMemo, useState } from 'react';
import type {
  DelegationPlan,
  DelegationAssignment,
  DelegationLimits,
  DelegationSnapshot,
  DelegationRevisionInput,
  ReviseDelegationInput,
  SaveDelegationPresetInput,
} from '@randolph/runtime/contracts';
import DelegationAssignmentEditor from './DelegationAssignmentEditor';
import DelegationPresetForm from './DelegationPresetForm';
import {
  clone,
  emptyAssignment,
  localErrors,
  normalizedPlan,
  same,
} from './delegation-plan-editor';
import './DelegationPanel.css';

type Props = {
  snapshot: DelegationSnapshot;
  onRevise: (input: ReviseDelegationInput) => Promise<void>;
  onReject: (input: DelegationRevisionInput) => Promise<void>;
  onApprove: (input: DelegationRevisionInput) => Promise<void>;
  onSavePreset: (input: SaveDelegationPresetInput) => Promise<void>;
};

export default function DelegationPanel({
  snapshot,
  onRevise,
  onReject,
  onApprove,
  onSavePreset,
}: Props) {
  const revision = snapshot.plan;
  const [draft, setDraft] = useState<DelegationPlan | undefined>(() =>
    revision ? clone(revision.plan) : undefined,
  );
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
  const errors = useMemo(() => (draft ? localErrors(draft) : []), [draft]);
  const revisionInput = revision
    ? {
        runId: snapshot.runId,
        planId: revision.id,
        digest: revision.digest,
        basisDigest: revision.basisDigest,
      }
    : undefined;
  const blocked = [...snapshot.blockedReasons, ...snapshot.validationErrors, ...errors];
  const canApprove = Boolean(
    revisionInput &&
    snapshot.canApprove &&
    !dirty &&
    !awaitingRevisionRefresh &&
    !errors.length &&
    !snapshot.validationErrors.length &&
    !snapshot.blockedReasons.length,
  );
  const canDecide = snapshot.canEdit && ['draft', 'ready'].includes(revision?.disposition ?? '');

  const updateLimits = (value: Partial<DelegationLimits>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            limits: { ...current.limits, ...value },
          }
        : current,
    );
  const updateAssignment = (index: number, value: Partial<DelegationAssignment>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            assignments: current.assignments.map((assignment, item) =>
              item === index ? { ...assignment, ...value } : assignment,
            ),
          }
        : current,
    );
  const addAssignment = () =>
    setDraft((current) =>
      current
        ? {
            ...current,
            assignments: [...current.assignments, emptyAssignment(current.assignments.length)],
          }
        : current,
    );
  const removeAssignment = (index: number) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            assignments: current.assignments.filter((_, item) => item !== index),
          }
        : current,
    );
  const perform = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind);
    setError(undefined);
    setSaved(undefined);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Delegation action could not be completed.',
      );
    } finally {
      setBusy(undefined);
    }
  };

  if (!revision || !draft || !revisionInput) return null;

  const saveRevision = () =>
    void perform('save', async () => {
      setAwaitingPlanId(revision.id);
      try {
        await onRevise({ ...revisionInput, plan: normalizedPlan(draft) });
        setSaved('Revision saved. The retained revision refreshes before it can be authorized.');
      } catch (cause) {
        setAwaitingPlanId(undefined);
        throw cause;
      }
    });
  const savePreset = () =>
    void perform('preset', async () => {
      if (!presetId.trim() || !presetName.trim())
        throw new Error('Preset ID and name are required.');
      await onSavePreset({
        ...revisionInput,
        presetId: presetId.trim(),
        name: presetName.trim(),
        expectedSettingsRevision: snapshot.settings.revision,
      });
      setSaved('Preset saved. Saving a preset does not authorize execution.');
    });

  return (
    <section className="delegation-panel" aria-labelledby="delegation-title">
      <header className="delegation-header">
        <div>
          <span className="eyebrow">Controlled delegation</span>
          <h3 id="delegation-title">Plan revision {revision.revision}</h3>
          <p>
            {revision.source === 'preset' ? 'Preset-derived plan' : 'Main-agent proposal'} ·{' '}
            <code>{revision.digest.slice(0, 12)}</code>
          </p>
        </div>
        <span className={`delegation-disposition disposition-${revision.disposition}`}>
          {revision.disposition}
        </span>
      </header>
      <p className="delegation-copy">
        Review the exact harness, CLI, version, model, and effort for every assignment. Saving a
        revision and authorizing it are separate actions.
      </p>
      <details className="delegation-basis">
        <summary>Source and approval basis</summary>
        <dl>
          <dt>Plan digest</dt>
          <dd>
            <code>{revision.digest}</code>
          </dd>
          <dt>Basis digest</dt>
          <dd>
            <code>{revision.basisDigest}</code>
          </dd>
        </dl>
        <pre>{JSON.stringify(revision.basis, null, 2)}</pre>
      </details>

      <DelegationAssignmentEditor
        assignments={draft.assignments}
        limits={draft.limits}
        canEdit={snapshot.canEdit}
        busy={Boolean(busy)}
        onLimitsChange={updateLimits}
        onAssignmentChange={updateAssignment}
        onAdd={addAssignment}
        onRemove={removeAssignment}
      />

      {blocked.length ? (
        <section className="delegation-blocked" aria-label="Approval blockers">
          <strong>Approval is blocked</strong>
          <ul>
            {blocked.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {awaitingRevisionRefresh ? (
        <p className="delegation-awaiting" role="status">
          The saved revision must refresh before it can be authorized.
        </p>
      ) : null}
      {error || snapshot.settings.error ? (
        <p className="inline-error" role="alert">
          {error || snapshot.settings.error}
        </p>
      ) : null}
      {saved ? (
        <p className="delegation-saved" role="status">
          {saved}
        </p>
      ) : null}

      <DelegationPresetForm
        presetId={presetId}
        presetName={presetName}
        warnings={snapshot.presetSaveWarnings}
        disabled={Boolean(busy) || !canDecide}
        saveDisabled={
          Boolean(busy) ||
          !canDecide ||
          dirty ||
          awaitingRevisionRefresh ||
          !presetId.trim() ||
          !presetName.trim()
        }
        saving={busy === 'preset'}
        onPresetIdChange={setPresetId}
        onPresetNameChange={setPresetName}
        onSave={savePreset}
      />

      <section className="delegation-history" aria-label="Plan revision history">
        <h4>Retained revisions and tasks</h4>
        <ul>
          {snapshot.history.map((item) => (
            <li key={item.id}>
              <code>r{item.revision}</code> · {item.disposition} ·{' '}
              {new Date(item.createdAt).toLocaleString()}
            </li>
          ))}
        </ul>
        <div>
          {snapshot.tasks.length ? (
            snapshot.tasks.map((task) => (
              <span className={`delegation-task task-${task.state}`} key={task.id}>
                {task.assignmentId}: {task.state}
              </span>
            ))
          ) : (
            <span className="muted-copy">No authorized task graph yet.</span>
          )}
        </div>
      </section>

      <footer className="delegation-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={Boolean(busy) || !snapshot.canEdit || !dirty || errors.length > 0}
          onClick={saveRevision}
        >
          {busy === 'save' ? 'Saving revision…' : 'Save revision'}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={Boolean(busy) || !canDecide}
          onClick={() => void perform('reject', () => onReject(revisionInput))}
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject plan'}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={Boolean(busy) || !canApprove}
          onClick={() => void perform('approve', () => onApprove(revisionInput))}
        >
          {busy === 'approve' ? 'Authorizing…' : 'Authorize exact plan'}
        </button>
      </footer>
    </section>
  );
}
