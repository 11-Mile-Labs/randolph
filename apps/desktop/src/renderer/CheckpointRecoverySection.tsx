import type { CheckpointRecord, Run } from '@randolph/runtime/contracts';
import type { PendingRecovery } from './history-panel-types';

type Props = {
  run: Run;
  busy: boolean;
  canRestartSource: boolean;
  recoveryBlocked: boolean;
  pending?: PendingRecovery;
  onRestore: (checkpoint: CheckpointRecord) => void;
  onPrepare: (checkpoint: CheckpointRecord, kind: PendingRecovery['kind']) => void;
  onCancelPending: () => void;
  onExecute: () => void;
};

export default function CheckpointRecoverySection({
  run,
  busy,
  canRestartSource,
  recoveryBlocked,
  pending,
  onRestore,
  onPrepare,
  onCancelPending,
  onExecute,
}: Props) {
  return (
    <>
      <h3>Recoverable checkpoints</h3>
      <p>
        Restore files and Git history into a new folder. This does not start an agent or repeat a
        delivery action.
      </p>
      {recoveryBlocked ? (
        <p>
          Execution recovery is unavailable while this conversation has active work or unconfirmed
          process cleanup.
        </p>
      ) : null}
      {run.checkpointError ? (
        <p role="alert">The latest checkpoint could not be saved: {run.checkpointError}</p>
      ) : null}
      {!run.checkpoints?.length ? (
        <p>No recoverable checkpoint was retained for this run.</p>
      ) : (
        run.checkpoints.map((checkpoint) => (
          <article className="checkpoint-card" key={checkpoint.id}>
            <strong>
              {checkpoint.boundary === 'before-turn' ? 'Before turn' : 'Completed turn'}
            </strong>
            <span>{new Date(checkpoint.createdAt).toLocaleString()}</span>
            <code title={checkpoint.digest}>{checkpoint.digest.slice(0, 16)}</code>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => onRestore(checkpoint)}
            >
              Restore files to folder
            </button>
            <div className="checkpoint-actions">
              {run.status === 'interrupted' &&
              canRestartSource &&
              checkpoint.id === run.checkpoints?.at(-1)?.id ? (
                <button
                  className="secondary-button"
                  disabled={busy || recoveryBlocked}
                  onClick={() => onPrepare(checkpoint, 'restart')}
                >
                  Restart from checkpoint
                </button>
              ) : null}
              <button
                className="secondary-button"
                disabled={busy || recoveryBlocked}
                onClick={() => onPrepare(checkpoint, 'rerun')}
              >
                Rerun in new conversation
              </button>
            </div>
          </article>
        ))
      )}
      {pending ? (
        <section className="recovery-confirmation" aria-label="Confirm checkpoint execution">
          <h3>{pending.kind === 'restart' ? 'Restart this work?' : 'Rerun this checkpoint?'}</h3>
          <p>
            This starts the installed harness in a fresh project worktree using the saved{' '}
            {run.model} / {run.effort} configuration and context.{' '}
            {pending.kind === 'restart'
              ? 'The new run stays in the same conversation.'
              : 'The new run opens in a new linked conversation.'}
          </p>
          <p>
            Original history and files are preserved. Saved delivery actions are not repeated; new
            results require fresh checks and approval. AI output may differ.
          </p>
          <code>
            {run.harness === 'grok' ? 'Grok' : 'Codex'} · Checkpoint{' '}
            {pending.checkpoint.digest.slice(0, 16)} · {run.executionMode ?? 'read-only'}
          </code>
          <div className="checkpoint-actions">
            <button className="secondary-button" disabled={busy} onClick={onCancelPending}>
              Cancel recovery
            </button>
            <button
              className="primary-button"
              disabled={busy || recoveryBlocked}
              onClick={onExecute}
            >
              {busy ? 'Starting…' : 'Start linked run'}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
