import type { ProjectSetupSnapshot, Run, RunEvent } from '@randolph/runtime/contracts';

const active = (status: Run['status']) =>
  status === 'starting' || status === 'running' || status === 'stopping';

export default function ProjectSetupActivity({
  setup,
  currentRun,
  events,
  latest,
  error,
  busy,
  draftStale,
  onReconcile,
  onStop,
}: {
  setup?: ProjectSetupSnapshot;
  currentRun?: Run;
  events: RunEvent[];
  latest?: ProjectSetupSnapshot['inspections'][number];
  error?: string;
  busy: boolean;
  draftStale: boolean;
  onReconcile: () => void;
  onStop: () => void;
}) {
  return (
    <>
      {draftStale ? (
        <p className="inline-error" role="alert">
          A newer proposal is available. Reload before approving it.
        </p>
      ) : null}
      {setup?.cleanup ? (
        <section className="setup-cleanup" aria-label="Inspection cleanup">
          <p className="inline-error" role="alert">
            {setup.cleanup.reason}
          </p>
          <button
            className="secondary-button"
            type="button"
            onClick={onReconcile}
            disabled={busy || !setup.cleanup.canReconcile}
          >
            Verify inspection cleanup
          </button>
        </section>
      ) : null}
      {currentRun && active(currentRun.status) ? (
        <div className="setup-activity" role="status">
          <strong>Inspection {currentRun.status}</strong>
          <p>Native setup activity is being recorded in the Project setup conversation.</p>
          <button className="secondary-button" type="button" onClick={onStop} disabled={busy}>
            Stop inspection
          </button>
        </div>
      ) : null}
      {events.length ? (
        <section className="setup-events" aria-label="Inspection activity">
          <h4>Tool activity</h4>
          <ul>
            {events.toReversed().map((event) => (
              <li key={`${event.runId}-${event.sequence}`}>
                <strong>{event.summary}</strong> <small>{event.type}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {latest?.error ? (
        <p className="inline-error" role="alert">
          {latest.error}
        </p>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
