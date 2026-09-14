import type { Run, RunEvent, RunExecutionSnapshot } from '@randolph/runtime/contracts';
import { StopIcon } from './icons';
import { formatTime, relativeTime } from './time';
import { NATIVE_EVENT_TYPES } from './workspace-helpers';

export type ActivityPanelProps = {
  run?: Run;
  execution?: RunExecutionSnapshot;
  events: RunEvent[];
  dataRoot: string;
  now: number;
  stopping: boolean;
  onStop: (runId: string) => void;
};

export default function ActivityPanel({ run, execution, events, dataRoot, now, stopping, onStop }: ActivityPanelProps) {
  const lastNativeEvent = events.findLast((event) => NATIVE_EVENT_TYPES.has(event.type));
  const canStop = run ? run.status === 'starting' || run.status === 'running' : false;
  const lastResponse = events.findLast(event => event.type === 'message.delta');
  const visibleEvents = events.filter(event => event.type.startsWith('run.') || event.type.startsWith('verification.') || event.type.startsWith('delivery.') || event.type.startsWith('review.') || event.type === 'command.completed' || event.type === 'file.changed' || event.type === 'session.started' || event.type === 'approval.denied' || event.sequence === lastResponse?.sequence || (event.data.method === 'item/started' && event.data.itemType === 'commandExecution')).slice(-12);


  return (
    <aside className="activity-panel" aria-label="Live activity">
      <div className="activity-heading">
        <div>
          <span className="eyebrow">Current run</span>
          <h2>Live activity</h2>
        </div>
        {run ? <span className={`status-dot ${execution?.status ?? run.status}`} aria-hidden="true" /> : null}
      </div>

      {!run ? (
        <div className="activity-empty">
          <span className="quiet-pulse" aria-hidden="true" />
          <strong>No active run</strong>
          <p>Native activity will appear here after you send a message.</p>
        </div>
      ) : (
        <>
          <div className="status-card">
            <div className="status-row">
              <span>Status</span>
              <strong>{(execution?.status ?? run.status).replace('-', ' ')}</strong>
            </div>
            <div className="status-row">
              <span>Last native event</span>
              <strong>{lastNativeEvent ? relativeTime(lastNativeEvent.at, now) : 'None recorded'}</strong>
            </div>
            <div className="status-row">
              <span>Model</span>
              <strong>{run.model}</strong>
            </div>
          </div>

          {run.checkpointError ? <p className="inline-error" role="status">Checkpoint unavailable: {run.checkpointError}</p> : run.checkpoints?.length ? <p className="muted-copy">{run.checkpoints.length} recoverable checkpoints · Open Run history to restore</p> : null}
          {run.memory?.references.length ? <details className="run-context"><summary>{run.memory.references.length} supplied lessons · ~{run.memory.estimatedTokens} tokens (estimate)</summary><pre>{run.memory.text}</pre></details> : null}
          {run.error ? (
            <div className="inline-error" role="alert">
              {run.error}
            </div>
          ) : null}

          <button
            className="stop-button"
            type="button"
            disabled={!canStop || stopping}
            onClick={() => onStop(run.id)}
          >
            <StopIcon />
            {stopping || run.status === 'stopping' ? 'Stopping…' : 'Stop run'}
          </button>

          <div className="event-list" aria-label="Run events">
            {events.length === 0 ? (
              <p className="muted-copy">Waiting for the first native event.</p>
            ) : (
              visibleEvents
                .toReversed()
                .map((event) => (
                  <details className="event-item" key={`${event.runId}-${event.sequence}`}>
                    <summary>
                      <span className="event-line" aria-hidden="true" />
                      <span>
                        <strong>{event.summary}</strong>
                        <small>{formatTime(event.at)}</small>
                      </span>
                    </summary>
                    <div className="event-detail">
                      <code>{event.type}</code>
                      {Object.keys(event.data).length > 0 ? (
                        <pre>{JSON.stringify(event.data, null, 2)}</pre>
                      ) : (
                        <p>No additional details.</p>
                      )}
                    </div>
                  </details>
                ))
            )}
          </div>
          <details className="native-records">
            <summary>All {events.length} recorded events</summary>
            <pre>{events.map(event => `${event.at} ${event.type} ${event.summary} ${JSON.stringify(event.data)}`).join("\n")}</pre>
          </details>
        </>
      )}

      <details className="storage-detail">
        <summary>Stored run data</summary>
        <p>{run?.logsPath ? 'Durable logs for this run:' : 'Randolph data root:'}</p>
        <code>{run?.logsPath || dataRoot || 'Data path unavailable'}</code>
        {run ? <p className="run-identifier">Run ID: {run.id}</p> : null}
      </details>
    </aside>
  );
}
