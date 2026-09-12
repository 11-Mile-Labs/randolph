import { useEffect, useRef, useState } from 'react';
import type { ReviewRecord } from '@randolph/runtime/contracts';

type Props = { review: ReviewRecord; onClose: () => void; onChanged: () => Promise<void>; onRefresh: () => Promise<void> };

export default function ReviewPanel({ review, onClose, onChanged, onRefresh }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState(review.deliveryPlan?.commitContent.split('\n\n').slice(1).join('\n\n').trim() ?? 'Update project files');
  const [accepted, setAccepted] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const checking = review.status === 'checking';
  const delivered = review.status === 'delivered';
  const canVerify = !review.deliveryPlan && (review.status === 'pending' || review.status === 'interrupted');
  const canApprove = (review.status === 'pending' || (review.status === 'interrupted' && Boolean(review.deliveryPlan))) && review.verification?.status === 'passed' && !delivered;

  useEffect(() => {
    const dialog = dialogRef.current; dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [checking]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review operation failed.'); }
    finally { await onChanged(); setBusy(false); }
  };

  return (
    <dialog className="review-panel" ref={dialogRef} aria-labelledby="review-title" onCancel={event => { event.preventDefault(); onClose(); }}>
      <header>
        <div><span className="eyebrow">Final review</span><h2 id="review-title">Review changes</h2></div>
        <button className="secondary-button" type="button" onClick={onClose}>Close review</button>
      </header>
      <p className="review-target">{review.basis.files.length} changed files · Target: <strong>{review.basis.parentBranch}</strong> at <code>{review.basis.parentOid.slice(0, 8)}</code></p>
      <div className="review-content">
        <aside aria-label="Changed files">
          {review.basis.files.map(file => <div className="review-file" key={file.path}><strong>{file.path}</strong><span>{file.binary ? 'Binary' : `+${file.additions} −${file.deletions}`} · {file.status}</span></div>)}
        </aside>
        <pre className="review-diff" aria-label="Combined diff">{review.basis.diff}</pre>
      </div>
      {review.basis.truncated ? <p className="inline-error">The diff exceeds the display limit. Inspect the complete changes in the worktree before approving.</p> : null}
      <section className="review-checks" aria-label="Verification">
        <div className="review-checks-header">
          <strong>{checking ? 'Running project checks…' : review.verification?.status === 'passed' ? 'Checks passed' : review.verification ? `Checks ${review.verification.status}` : 'Checks have not run'}</strong>
          {checking ? <button className="secondary-button" type="button" onClick={() => void window.randolph.stopReview(review.id)}>Stop checks</button> :
            <button className="secondary-button" type="button" disabled={busy || !canVerify} onClick={() => void perform(() => window.randolph.verifyReview(review.id))}>Run project checks</button>}
        </div>
        {checking && review.progress ? <div className="verification-progress" aria-live="polite"><p>{review.progress.checkId} · {Math.max(0, Math.floor((clock - Date.parse(review.progress.startedAt)) / 1000))}s elapsed</p><pre aria-label="Live check output">{review.progress.output || 'Waiting for command output…'}</pre></div> : null}
        {review.verification?.checks.map((check, index) => <details key={`${check.command.id}-${index}`}>
          <summary>{check.command.label} · {check.status} · exit {check.exitCode ?? 'unknown'}</summary>
          <pre>{check.output || check.error || 'No output recorded.'}{check.truncated ? '\n[Output truncated]' : ''}</pre>
        </details>)}
        {review.verification?.status === 'unavailable' ? <p>No supported project checks were found. Add verification scripts to the project and request a new review.</p> : null}
      </section>
      {(error || review.error) ? <p className="inline-error" role="alert">{error || review.error}</p> : null}
      {delivered ? <div className="delivery-success" role="status"><strong>Local delivery complete</strong><p>Commit <code>{review.commitOid?.slice(0, 8)}</code> merged into {review.basis.parentBranch}. {review.cleaned ? 'The temporary worktree was removed.' : 'Worktree cleanup is pending.'} Nothing was pushed.</p></div> : <>
        <label className="commit-message-label">Commit message<textarea aria-label="Commit message" maxLength={16000} value={message} disabled={busy || Boolean(review.deliveryPlan)} onChange={event => { setMessage(event.target.value); setAccepted(false); }} rows={2} /></label>
        <label className="review-consent"><input type="checkbox" checked={accepted} disabled={busy || checking || !canApprove} onChange={event => setAccepted(event.target.checked)} />I reviewed the changes and checks</label>
        <p className="review-approval-copy">Final approval commits all non-ignored worktree changes, merges the reviewed result into {review.basis.parentBranch}, and removes the temporary worktree. Push is a separate action.</p>
      </>}
      <footer>
        <button className="secondary-button" type="button" disabled={busy || checking || delivered || review.status === 'stop-unconfirmed'} onClick={() => void perform(onRefresh)}>Refresh review</button>
        {!delivered ? <button className="primary-button" type="button" disabled={busy || checking || !canApprove || !accepted || !message.trim()} onClick={() => void perform(() => window.randolph.approveReview({ reviewId: review.id, message }))}>{review.deliveryPlan ? 'Continue approved delivery' : 'Approve commit and merge'}</button> : null}
      </footer>
    </dialog>
  );
}
