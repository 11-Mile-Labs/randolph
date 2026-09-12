import { useEffect, useRef, useState } from 'react';
import type { CheckpointRecord, Message, ReviewRecord, Run, RunEvent } from '@randolph/runtime/contracts';

type Props = { runs: Run[]; messages: Message[]; events: RunEvent[]; reviews: ReviewRecord[]; onClose: () => void };
export default function HistoryPanel({ runs, messages, events, reviews, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const [selected, setSelected] = useState(runs[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [restored, setRestored] = useState<string>();
  const run = runs.find(candidate => candidate.id === selected);
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
    <div className="history-body"><nav aria-label="Historical runs">{runs.map(item => <button key={item.id} className={item.id === selected ? 'selected' : ''} onClick={() => { setSelected(item.id); setError(undefined); setRestored(undefined); }}><strong>{new Date(item.createdAt).toLocaleString()}</strong><span>{item.status} · {item.checkpoints?.length ?? 0} checkpoints</span></button>)}</nav>
      <div className="history-detail">{!run ? <p>No runs retained yet.</p> : <>
        <h3>{run.status}</h3><p>{run.model} · {run.effort} · {run.executionMode ?? 'read-only'}</p>
        {run.error ? <p role="status">{run.error}</p> : null}
        <h3>Recoverable checkpoints</h3>
        <p>Restore files and Git history into a new folder. This does not start an agent or repeat a delivery action.</p>
        {run.checkpointError ? <p role="alert">The latest checkpoint could not be saved: {run.checkpointError}</p> : null}
        {!run.checkpoints?.length ? <p>No recoverable checkpoint was retained for this run.</p> : run.checkpoints.map(checkpoint => <article className="checkpoint-card" key={checkpoint.id}><strong>{checkpoint.boundary === 'before-turn' ? 'Before turn' : 'Completed turn'}</strong><span>{new Date(checkpoint.createdAt).toLocaleString()}</span><code title={checkpoint.digest}>{checkpoint.digest.slice(0, 16)}</code><button className="secondary-button" disabled={busy} onClick={() => void restore(checkpoint)}>{busy ? 'Restoring…' : 'Restore files to folder'}</button></article>)}
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
