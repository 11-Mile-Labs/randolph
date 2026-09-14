import { useEffect, useState } from 'react';
import type { RunExecutionSnapshot } from '@randolph/runtime/contracts';
import './RunActivity.css';

const harnessName = (harness: string): string => (harness === 'codex' ? 'Codex' : 'Grok');
const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

export default function RunActivity({
  runId,
  onSnapshot,
}: {
  runId: string;
  onSnapshot: (value: RunExecutionSnapshot | undefined) => void;
}) {
  const [snapshot, setSnapshot] = useState<RunExecutionSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true,
      request = 0;
    const refresh = () => {
      const sequence = ++request;
      void (async () => {
        try {
          const value = await window.randolph.runExecutionSnapshot(runId);
          if (current && sequence === request) {
            setSnapshot(value);
            onSnapshot(value);
            setError(undefined);
          }
        } catch (cause) {
          if (current && sequence === request)
            setError(cause instanceof Error ? cause.message : 'Could not read run activity.');
        }
      })();
    };
    setSnapshot(undefined);
    onSnapshot(undefined);
    refresh();
    const unsubscribe = window.randolph.onChanged(refresh);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [runId, onSnapshot]);
  if (error)
    return (
      <p className="inline-error" role="alert">
        {error}
      </p>
    );
  if (
    !snapshot ||
    (!snapshot.operations.length &&
      !snapshot.control &&
      !snapshot.tasks.length &&
      !snapshot.cleanupRequired)
  )
    return null;
  return (
    <section className="run-activity" aria-label="Run activity">
      <header>
        <h3>Run activity</h3>
        <span className="run-activity-status">{snapshot.status}</span>
      </header>
      <p className="run-capacity">
        App slots {snapshot.capacity.occupied}/{snapshot.capacity.limit}
        {snapshot.capacity.harnesses.map((item) => (
          <span key={item.harness}>
            {harnessName(item.harness)} {item.occupied}/{item.limit}
          </span>
        ))}
      </p>
      <p className="run-activity-note">
        Slot counts include other runs and slots held until cleanup is confirmed.
      </p>
      {snapshot.control ? (
        <p>
          Active time recorded: {minutes(snapshot.control.spentMs)} /{' '}
          {minutes(snapshot.control.budgetMs)} minutes · Priority {snapshot.control.priority}
        </p>
      ) : null}
      {snapshot.cleanupRequired ? (
        <div role="status">
          <p>Execution is interrupted. Review retained work and cleanup before starting again.</p>
          {snapshot.cleanupReasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
      ) : null}
      {snapshot.operations.length ? (
        <ul aria-label="Native operations">
          {snapshot.operations.map((operation) => (
            <li key={operation.id}>
              <strong>{operation.label}</strong>
              <span>
                {harnessName(operation.harness)} ·{' '}
                {operation.status === 'admitted'
                  ? 'Active'
                  : operation.status === 'quarantined'
                    ? 'Cleanup unconfirmed'
                    : 'Queued'}
              </span>
              {operation.reason ? <p>{operation.reason}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot.tasks.length ? (
        <details>
          <summary>Tasks ({snapshot.tasks.length})</summary>
          <ul>
            {snapshot.tasks.map((task) => (
              <li key={task.id}>
                <strong>{task.label}</strong>
                <span>
                  {harnessName(task.harness)} · {task.status}
                </span>
                {task.reason ? <p>{task.reason}</p> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
