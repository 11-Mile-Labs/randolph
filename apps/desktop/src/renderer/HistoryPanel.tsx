import { useEffect, useRef, useState } from 'react';
import type {
  CheckpointRecord,
  Message,
  ReviewRecord,
  Run,
  RunEvent,
} from '@randolph/runtime/contracts';
import CheckpointRecoverySection from './CheckpointRecoverySection';
import HistoryRunList from './HistoryRunList';
import RecordedOutcomeSections from './RecordedOutcomeSections';
import type { PendingRecovery } from './history-panel-types';

export type { PendingRecovery } from './history-panel-types';

type Props = {
  runs: Run[];
  messages: Message[];
  events: RunEvent[];
  reviews: ReviewRecord[];
  onRecovered: (conversationId: string) => Promise<void>;
  onClose: () => void;
};
export default function HistoryPanel({
  runs,
  messages,
  events,
  reviews,
  onRecovered,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const [selected, setSelected] = useState(runs[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [restored, setRestored] = useState<string>();
  const [pending, setPending] = useState<PendingRecovery>();
  const run = runs.find((candidate) => candidate.id === selected);
  const latest = runs.find((candidate) => candidate.conversationId === run?.conversationId);
  const canRestartSource =
    latest?.id === run?.id ||
    (latest?.status === 'failed' &&
      latest.recoveryKind === 'restart' &&
      latest.sourceRunId === run?.id &&
      !latest.checkpoints?.length);
  const recoveryBlocked = runs.some(
    (candidate) =>
      candidate.conversationId === run?.conversationId &&
      (candidate.cleanupUnconfirmed ||
        ['starting', 'running', 'stopping', 'stop-unconfirmed'].includes(candidate.status)),
  );
  async function executeCheckpoint() {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    try {
      const input = {
        runId: pending.checkpoint.runId,
        checkpointDigest: pending.checkpoint.digest,
      };
      const result =
        pending.kind === 'restart'
          ? await window.randolph.restartRun(input)
          : await window.randolph.rerunFromCheckpoint(input);
      await onRecovered(result.conversation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkpoint execution could not start.');
    } finally {
      setBusy(false);
    }
  }
  async function restore(checkpoint: CheckpointRecord) {
    setBusy(true);
    setError(undefined);
    setRestored(undefined);
    try {
      const result = await window.randolph.restoreCheckpoint({
        runId: checkpoint.runId,
        digest: checkpoint.digest,
      });
      if (result) setRestored(result.workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkpoint restoration failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="history-dialog"
      aria-labelledby="history-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">Retained evidence</span>
          <h2 id="history-title">Run history</h2>
        </div>
        <button className="secondary-button" disabled={busy} onClick={onClose}>
          Close history
        </button>
      </header>
      <div className="history-body">
        <HistoryRunList
          runs={runs}
          selected={selected}
          busy={busy}
          onSelect={(runId) => {
            setSelected(runId);
            setError(undefined);
            setRestored(undefined);
            setPending(undefined);
          }}
        />
        <div className="history-detail">
          {!run ? (
            <p>No runs retained yet.</p>
          ) : (
            <>
              <h3>{run.status}</h3>
              <p>
                {run.harness === 'grok' ? 'Grok' : 'Codex'} · {run.model} · {run.effort} ·{' '}
                {run.executionMode ?? 'read-only'}
              </p>
              {run.sourceRunId ? (
                <p>
                  {run.recoveryKind === 'restart' ? 'Restarted from' : 'Rerun of'}{' '}
                  <code>{run.sourceRunId}</code> · checkpoint{' '}
                  <code>{run.sourceCheckpointDigest?.slice(0, 16)}</code>{' '}
                  {runs.some((candidate) => candidate.id === run.sourceRunId) ? (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => {
                        if (run.sourceRunId) setSelected(run.sourceRunId);
                        setPending(undefined);
                        setError(undefined);
                        setRestored(undefined);
                      }}
                    >
                      View source run
                    </button>
                  ) : null}
                </p>
              ) : null}
              {run.error ? <p role="status">{run.error}</p> : null}
              <CheckpointRecoverySection
                run={run}
                busy={busy}
                canRestartSource={canRestartSource}
                recoveryBlocked={recoveryBlocked}
                pending={pending}
                onRestore={(checkpoint) => void restore(checkpoint)}
                onPrepare={(checkpoint, kind) => {
                  setPending({ checkpoint, kind });
                  setError(undefined);
                }}
                onCancelPending={() => setPending(undefined)}
                onExecute={() => void executeCheckpoint()}
              />
              {error ? <p role="alert">{error}</p> : null}
              {restored ? (
                <p role="status">
                  Restored to <code>{restored}</code>. Original history is unchanged.
                </p>
              ) : null}
              <details>
                <summary>Saved configuration and supplied lessons</summary>
                <pre>
                  {JSON.stringify(
                    {
                      executable: run.executable,
                      executableVersion: run.executableVersion,
                      model: run.model,
                      effort: run.effort,
                      executionMode: run.executionMode ?? 'read-only',
                      settingsSource: run.settingsSource,
                      projectSettingsRevision: run.projectSettingsRevision,
                      memory: run.memory,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <RecordedOutcomeSections
                runId={run.id}
                reviews={reviews}
                events={events}
                messages={messages}
              />
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
