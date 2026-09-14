import { useEffect, useState } from 'react';
import type { ReviewRecord } from '@randolph/runtime/contracts';
export default function PushControls({
  review,
  onChanged,
}: {
  review: ReviewRecord;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const push = review.push;
  useEffect(() => setAccepted(false), [push?.revision]);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Origin operation failed.');
    } finally {
      await onChanged();
      setBusy(false);
    }
  };
  return (
    <section className="push-controls" aria-label="Separate origin push">
      <h3>Push to origin</h3>
      <p>Local delivery is complete. Publishing this commit requires its own approval.</p>
      {push ? (
        <>
          <p>
            Destination: <code>{push.plan.originUrl}</code>
            <br />
            Branch: <strong>{push.plan.branch}</strong> · Commit:{' '}
            <code>{push.plan.localOid.slice(0, 12)}</code>
          </p>
          {push.status === 'pushed' ? (
            <p role="status">Push confirmed on the approved origin branch.</p>
          ) : (
            <>
              <p>
                Status: {push.status}. {push.error}
              </p>
              {push.status === 'preview' ? (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={accepted}
                      disabled={busy}
                      onChange={(event) => setAccepted(event.target.checked)}
                    />
                    I approve pushing this commit to this origin branch
                  </label>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !accepted}
                    onClick={() =>
                      void perform(() =>
                        window.randolph.approvePush({
                          reviewId: review.id,
                          revision: push.revision,
                        }),
                      )
                    }
                  >
                    Push approved commit
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void perform(() => window.randolph.checkPush(review.id))}
              >
                Recheck push outcome
              </button>
              {busy ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void window.randolph.stopPush(review.id)}
                >
                  Stop origin operation
                </button>
              ) : null}
            </>
          )}
        </>
      ) : null}
      {!push || push.status === 'stale' ? (
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void perform(() => window.randolph.previewPush(review.id))}
        >
          Preview origin push
        </button>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
