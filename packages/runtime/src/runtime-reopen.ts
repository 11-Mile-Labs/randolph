import type { Store } from './store.js';
import type { DelegationCommands } from './delegation-commands.js';
import type { DelegationControls } from './delegation-control.js';
import { ACTIVE_RUN_STATUSES, now } from './runtime-status.js';

export function reconcileInterruptedRuns(
  store: Store,
  delegation: DelegationCommands,
  controls: DelegationControls,
): void {
  for (const run of store.runs()) {
    const sessions = delegation.records.sessions(run.id);
    const nativeCleanupConfirmed =
      sessions.length > 0 &&
      sessions.every((session) => session.cleanupConfirmed === true) &&
      !controls
        .read(run.id)
        ?.activities.some((activity) => activity.state === 'cleanup-unconfirmed');
    if (
      ['starting', 'running', 'stopping'].includes(run.status) &&
      run.cleanupUnconfirmed !== true &&
      nativeCleanupConfirmed
    ) {
      run.status = 'interrupted';
      run.cleanupUnconfirmed = false;
      run.updatedAt = now();
      run.error = 'The application ended after native cleanup. No work has been resumed.';
      store.transaction(() => {
        store.putRun(run);
        store.append(run, 'run.interrupted', run.error!, { nativeCleanupConfirmed: true });
      });
    } else if (
      ACTIVE_RUN_STATUSES.has(run.status) ||
      (!run.cleanupUnconfirmed &&
        (delegation.records
          .sessions(run.id)
          .some((session) => session.state === 'cleanup-unconfirmed') ||
          controls
            .read(run.id)
            ?.activities.some((activity) => activity.state === 'cleanup-unconfirmed')))
    ) {
      store.transaction(() => {
        run.status = 'interrupted';
        run.cleanupUnconfirmed = true;
        run.updatedAt = now();
        run.error =
          'The application ended during this run. It has not been restarted; previous process cleanup could not be verified.';
        store.putRun(run);
        store.append(run, 'run.interrupted', run.error);
      });
    } else if (
      delegation.records
        .tasks(run.id)
        .some((task) => task.attempts.some((attempt) => attempt.runtimeRecoveryRequired)) &&
      run.status !== 'interrupted'
    ) {
      store.transaction(() => {
        run.status = 'interrupted';
        run.updatedAt = now();
        run.error =
          'Native cleanup completed, but delegated task processing was unfinished when the application ended. Explicit recovery is required; no task has been restarted.';
        store.putRun(run);
        store.append(run, 'run.interrupted', run.error, {
          nativeCleanupConfirmed: true,
          taskRecoveryRequired: true,
        });
      });
    }
    store.exportRun(run);
  }
}
