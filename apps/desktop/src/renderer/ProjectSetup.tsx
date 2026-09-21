import { useEffect, useRef, useState } from 'react';
import type {
  HarnessId,
  HarnessInfo,
  HarnessInstallation,
  Project,
  ProjectContext,
  ProjectSetupSnapshot,
  Run,
  RunEvent,
} from '@randolph/runtime/contracts';
import ProjectSetupApproved from './ProjectSetupApproved';
import ProjectSetupProposal from './ProjectSetupProposal';
import ProjectSetupActivity from './ProjectSetupActivity';

type Props = { project: Project; onClose: () => void; onChanged: () => Promise<void> };
const emptyContext: ProjectContext = { purpose: '', instructions: '', documents: [] };
const active = (status: Run['status']) =>
  status === 'starting' || status === 'running' || status === 'stopping';

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
  const selectedModel = harness?.models.find((item) => item.id === model);
  const selectedInspection = latest?.proposal?.value;
  const currentRun = latest?.run;
  const proposalIdentity = latest?.proposal
    ? `${latest.run.id}:${latest.proposal.revision}`
    : undefined;
  const draftStale = Boolean(proposalIdentity && draftRevisionRef.current !== proposalIdentity);
  const blockedRun = Boolean(
    setup?.inspections.some(
      (item) =>
        active(item.run.status) ||
        item.run.cleanupUnconfirmed ||
        item.run.status === 'stop-unconfirmed',
    ),
  );
  const canInspect = Boolean(
    !blockedRun &&
    harness?.available &&
    harness.authenticated &&
    selectedModel &&
    selectedModel.efforts.includes(effort) &&
    harness?.executionModes?.includes('read-only'),
  );
  const harnessStatus = busy
    ? 'Checking the selected harness.'
    : !harness
      ? 'Could not determine harness availability.'
      : canInspect
        ? `${harness.harness === 'codex' ? 'Codex' : 'Grok'} is ready for read-only inspection.`
        : (harness.reason ??
          (!harness.available
            ? 'The selected CLI is unavailable. Install it or choose an installed copy.'
            : !harness.authenticated
              ? 'Sign in to the selected CLI before inspecting this project.'
              : !selectedModel
                ? 'Choose an available model before inspecting this project.'
                : !harness.executionModes?.includes('read-only')
                  ? 'This harness is not verified for read-only inspection.'
                  : 'Wait for the existing inspection to finish or verify its cleanup.'));

  const load = async (resetDraft = false) => {
    try {
      const next = await window.randolph.projectSetup(project.id);
      setSetup(next);
      const workspace = await window.randolph.snapshot();
      setEvents(
        workspace.events
          .filter((event) => next.inspections.some((item) => item.run.id === event.runId))
          .slice(-10),
      );
      const nextInspection = next.inspections.at(-1);
      const nextRevision = nextInspection?.proposal
        ? `${nextInspection.run.id}:${nextInspection.proposal.revision}`
        : undefined;
      if (resetDraft || !draftDirtyRef.current) {
        setDraft(next.inspections.at(-1)?.proposal?.value.context ?? next.context.value);
        draftRevisionRef.current = nextRevision;
        draftDirtyRef.current = false;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load project setup.');
    }
  };
  const loadHarness = async (nextHarness: HarnessId, nextExecutable?: string) => {
    setHarnessId(nextHarness);
    setBusy(true);
    setError(undefined);
    try {
      const [copies, info] = await Promise.all([
        window.randolph.harnessInstallations(nextHarness),
        window.randolph.harness(project.id, nextExecutable || undefined, nextHarness),
      ]);
      setInstallations(copies);
      setHarness(info);
      setExecutable(nextExecutable ?? '');
      setModel(info.models[0]?.id ?? '');
      setEffort(info.models[0]?.defaultEffort ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not inspect the selected harness.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    dialogRef.current?.showModal();
    void Promise.all([load(), loadHarness('codex')]);
    const unsubscribe = window.randolph.onChanged(() => {
      void load();
      void onChanged();
    });
    return () => {
      unsubscribe();
      dialogRef.current?.close();
    };
  }, []);

  const updateDraft = (value: ProjectContext) => {
    setDraft(value);
    draftDirtyRef.current = true;
  };
  const inspect = async () => {
    if (!canInspect) return;
    setBusy(true);
    setError(undefined);
    try {
      await window.randolph.inspectProject({
        projectId: project.id,
        selection: { harness: harnessId, model, effort },
        executable: executable || undefined,
        brief,
      });
      setBrief('');
      await load();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Inspection could not start.');
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!latest?.proposal || !latest.canApprove || !currentRun?.projectContext || draftStale)
      return;
    setBusy(true);
    setError(undefined);
    try {
      await window.randolph.approveProjectSetup({
        projectId: project.id,
        runId: currentRun.id,
        proposalRevision: latest.proposal.revision,
        expectedContextRevision: currentRun.projectContext.revision,
        value: draft,
      });
      draftDirtyRef.current = false;
      await load(true);
      await onChanged();
    } catch (cause) {
      await load();
      setError(
        cause instanceof Error
          ? cause.message
          : 'Approval is stale. Reload the proposal and try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!currentRun) return;
    setBusy(true);
    try {
      await window.randolph.stop(currentRun.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not stop inspection.');
    } finally {
      setBusy(false);
    }
  };
  const reconcileCleanup = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await window.randolph.reconcileProjectSetupCleanup(project.id);
      await load();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not verify inspection cleanup.');
    } finally {
      setBusy(false);
    }
  };
  const saveDefault = async () => {
    if (!harness || !selectedModel || !selectedModel.efforts.includes(effort)) return;
    setBusy(true);
    setError(undefined);
    try {
      await window.randolph.saveProjectDefaults({
        projectId: project.id,
        defaults: { harness: harnessId, model, effort, executable: executable || null },
        expectedRevision: project.harnessSettings?.revision ?? null,
      });
      await onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save the selected agent as the project default.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      className="project-settings project-setup"
      ref={dialogRef}
      aria-labelledby="project-setup-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">{project.name}</span>
          <h2 id="project-setup-title">Project setup</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onClose}>
          Close project setup
        </button>
      </header>
      <p>
        Review the approved project context, then run a read-only inspection to propose updates.
        Opening this view never starts work.
      </p>
      <ProjectSetupApproved setup={setup} />
      <section className="settings-fields">
        <label>
          Harness
          <select
            value={harnessId}
            disabled={busy}
            onChange={(event) => void loadHarness(event.target.value as HarnessId)}
          >
            <option value="codex">Codex</option>
            <option value="grok">Grok · compatibility pending</option>
          </select>
        </label>
        <label>
          CLI
          <select
            value={executable}
            disabled={busy}
            onChange={(event) => void loadHarness(harnessId, event.target.value)}
          >
            <option value="">Automatic discovery</option>
            {installations.map((item) => (
              <option key={item.executable} value={item.executable}>
                {item.version ?? 'Unknown'} · {item.executable}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select
            value={model}
            disabled={busy || !harness?.available}
            onChange={(event) => {
              const item = harness?.models.find((value) => value.id === event.target.value);
              setModel(item?.id ?? '');
              setEffort(item?.defaultEffort ?? '');
            }}
          >
            <option value="">Choose a model</option>
            {harness?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reasoning effort
          <select
            value={effort}
            disabled={busy || !selectedModel}
            onChange={(event) => setEffort(event.target.value)}
          >
            {selectedModel?.efforts.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </section>
      <p
        className={canInspect ? 'muted-copy' : 'inline-error'}
        role={canInspect ? undefined : 'alert'}
      >
        {harnessStatus}
      </p>
      <label className="setup-brief">
        Setup idea or corrections
        <textarea
          aria-label="Setup idea or corrections"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          rows={3}
          placeholder="What should the inspection understand or correct?"
        />
      </label>
      <ProjectSetupProposal
        selectedInspection={selectedInspection}
        latest={latest}
        setup={setup}
        draft={draft}
        updateDraft={updateDraft}
      />
      <ProjectSetupActivity
        setup={setup}
        currentRun={currentRun}
        events={events}
        latest={latest}
        error={error}
        busy={busy}
        draftStale={draftStale}
        onReconcile={() => void reconcileCleanup()}
        onStop={() => void stop()}
      />
      <footer>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void load(true)}
          disabled={busy}
        >
          Reload
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void saveDefault()}
          disabled={busy || !canInspect}
        >
          Save selected agent as project default
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void inspect()}
          disabled={busy || !canInspect}
        >
          {busy ? 'Working…' : 'Inspect project'}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => void approve()}
          disabled={busy || !latest?.canApprove || draftStale || !draft.purpose.trim()}
        >
          Approve project context
        </button>
      </footer>
    </dialog>
  );
}
