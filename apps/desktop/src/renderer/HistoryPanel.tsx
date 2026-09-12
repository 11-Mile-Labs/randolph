import { useEffect, useRef, useState } from 'react';
import type { CheckpointRecord, Message, ReviewRecord, Run, RunEvent } from '@randolph/runtime/contracts';

type Props = { runs: Run[]; messages: Message[]; events: RunEvent[]; reviews: ReviewRecord[]; onRecovered: (conversationId: string) => Promise<void>; onClose: () => void };
export default function HistoryPanel({ runs, messages, events, reviews, onRecovered, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const [selected, setSelected] = useState(runs[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [restored, setRestored] = useState<string>();
  const [pending, setPending] = useState<{ checkpoint: CheckpointRecord; kind: 'restart' | 'rerun' }>();
  const run = runs.find(candidate => candidate.id === selected);
  const latest = runs.find(candidate => candidate.conversationId === run?.conversationId);
  const canRestartSource = latest?.id === run?.id || (latest?.status === 'failed' && latest.recoveryKind === 'restart' && latest.sourceRunId === run?.id && !latest.checkpoints?.length);
  const recoveryBlocked = runs.some(candidate => candidate.conversationId === run?.conversationId && (candidate.cleanupUnconfirmed || ['starting', 'running', 'stopping', 'stop-unconfirmed'].includes(candidate.status)));
  async function executeCheckpoint() {
    if (!pending) return;
    setBusy(true); setError(undefined);
    try {
      const input = { runId: pending.checkpoint.runId, checkpointDigest: pending.checkpoint.digest };
      const result = pending.kind === 'restart' ? await window.randolph.restartRun(input) : await window.randolph.rerunFromCheckpoint(input);
      await onRecovered(result.conversation.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Checkpoint execution could not start.'); }
    finally { setBusy(false); }
  }
  async function restore(checkpoint: CheckpointRecord) {
    setBusy(true); setError(undefined); setRestored(undefined);
    try {
      const result = await window.randolph.restoreCheckpoint({ runId: checkpoint.runId, digest: checkpoint.digest });
      if (result) setRestored(result.workspace);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Checkpoint restoration failed.'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="history-dialog" aria-labelledby="history-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><span className="eyebrow">Retained evidence</span><h2 id="history-title">Run history</h2></div><button className="secondary-button" disabled={busy} onClick={onClose}>Close history</button></header>
    <div className="history-body"><nav aria-label="Historical runs">{runs.map(item => <button key={item.id} disabled={busy} className={item.id === selected ? 'selected' : ''} onClick={() => { setSelected(item.id); setError(undefined); setRestored(undefined); setPending(undefined); }}><strong>{new Date(item.createdAt).toLocaleString()}</strong><span>{item.status} · {item.checkpoints?.length ?? 0} checkpoints</span></button>)}</nav>
      <div className="history-detail">{!run ? <p>No runs retained yet.</p> : <>
        <h3>{run.status}</h3><p>{run.model} · {run.effort} · {run.executionMode ?? 'read-only'}</p>
        {run.sourceRunId ? <p>{run.recoveryKind === 'restart' ? 'Restarted from' : 'Rerun of'} <code>{run.sourceRunId}</code> · checkpoint <code>{run.sourceCheckpointDigest?.slice(0, 16)}</code> {runs.some(candidate => candidate.id === run.sourceRunId) ? <button className="secondary-button" disabled={busy} onClick={() => { if (run.sourceRunId) setSelected(run.sourceRunId); setPending(undefined); setError(undefined); setRestored(undefined); }}>View source run</button> : null}</p> : null}
        {run.error ? <p role="status">{run.error}</p> : null}
        <h3>Recoverable checkpoints</h3>
        <p>Restore files and Git history into a new folder. This does not start an agent or repeat a delivery action.</p>
        {recoveryBlocked ? <p>Execution recovery is unavailable while this conversation has active work or unconfirmed process cleanup.</p> : null}
        {run.checkpointError ? <p role="alert">The latest checkpoint could not be saved: {run.checkpointError}</p> : null}
        {!run.checkpoints?.length ? <p>No recoverable checkpoint was retained for this run.</p> : run.checkpoints.map(checkpoint => <article className="checkpoint-card" key={checkpoint.id}><strong>{checkpoint.boundary === 'before-turn' ? 'Before turn' : 'Completed turn'}</strong><span>{new Date(checkpoint.createdAt).toLocaleString()}</span><code title={checkpoint.digest}>{checkpoint.digest.slice(0, 16)}</code><button className="secondary-button" disabled={busy} onClick={() => void restore(checkpoint)}>Restore files to folder</button><div className="checkpoint-actions">
          {run.status === 'interrupted' && canRestartSource && checkpoint.id === run.checkpoints?.at(-1)?.id ? <button className="secondary-button" disabled={busy || recoveryBlocked} onClick={() => { setPending({ checkpoint, kind: 'restart' }); setError(undefined); }}>Restart from checkpoint</button> : null}
          <button className="secondary-button" disabled={busy || recoveryBlocked} onClick={() => { setPending({ checkpoint, kind: 'rerun' }); setError(undefined); }}>Rerun in new conversation</button>
        </div></article>)}
        {pending ? <section className="recovery-confirmation" aria-label="Confirm checkpoint execution">
          <h3>{pending.kind === 'restart' ? 'Restart this work?' : 'Rerun this checkpoint?'}</h3>
          <p>This starts the installed harness in a fresh project worktree using the saved {run.model} / {run.effort} configuration and context. {pending.kind === 'restart' ? 'The new run stays in the same conversation.' : 'The new run opens in a new linked conversation.'}</p>
          <p>Original history and files are preserved. Saved delivery actions are not repeated; new results require fresh checks and approval. AI output may differ.</p>
          <code>Checkpoint {pending.checkpoint.digest.slice(0, 16)} · {run.executionMode ?? 'read-only'}</code>
          <div className="checkpoint-actions"><button className="secondary-button" disabled={busy} onClick={() => setPending(undefined)}>Cancel recovery</button><button className="primary-button" disabled={busy || recoveryBlocked} onClick={() => void executeCheckpoint()}>{busy ? 'Starting…' : 'Start linked run'}</button></div>
        </section> : null}
        {error ? <p role="alert">{error}</p> : null}
        {restored ? <p role="status">Restored to <code>{restored}</code>. Original history is unchanged.</p> : null}
        <details><summary>Saved configuration and supplied lessons</summary><pre>{JSON.stringify({ model: run.model, effort: run.effort, executionMode: run.executionMode ?? 'read-only', settingsSource: run.settingsSource, projectSettingsRevision: run.projectSettingsRevision, memory: run.memory }, null, 2)}</pre></details>
        <section aria-label="Recorded delivery" className="history-delivery">
          <h3>Recorded delivery</h3>
          <p>These are saved outcomes from the original run. Opening history does not repeat them.</p>
          {!reviews.some(review => review.runId === run.id) ? <p>No delivery review recorded.</p> : reviews.filter(review => review.runId === run.id).map(review => <article key={review.id}>
            <strong>{review.status}</strong>
            <p>{review.verification ? `Checks ${review.verification.status}` : 'Checks not recorded'}</p>
            {review.commitOid ? <p>Retained commit <code>{review.commitOid}</code></p> : <p>No confirmed commit recorded.</p>}
            <p>{review.merged ? `Merged to ${review.basis.parentBranch}` : 'Merge not confirmed'} · {review.cleaned ? 'Worktree removed' : 'Cleanup not confirmed'}</p>
            {review.error ? <p>{review.error}</p> : null}
          </article>)}
        </section>
        <section aria-label="Recorded activity">
          <h3>Recorded activity</h3>
          <ol className="history-timeline">{events.filter(event => event.runId === run.id).map(event => <li key={event.sequence}>
            <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
            <p>{event.summary}</p>
            <details><summary>{event.type}</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>
          </li>)}</ol>
        </section>
        <h3>Messages from this run</h3>{messages.filter(message => message.runId === run.id).map(message => <article className="history-message" key={message.id}><strong>{message.role}</strong><p>{message.text}</p></article>)}
      </>}</div></div>
  </dialog>;
}
