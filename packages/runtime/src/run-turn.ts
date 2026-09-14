import { randomUUID } from 'node:crypto';
import { assertWorkspaceIdentity } from './workspace-identity.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { AdapterRunFailure } from './contracts.js';
import type { AdapterEvent, Run } from './contracts.js';
import type { WorkspaceLease } from './workspace-leases.js';
import { now } from './runtime-status.js';
import type { RuntimeBindings } from './runtime-bindings.js';

export function finishRun(
  host: Pick<RuntimeBindings, 'store'>,
  run: Run,
  status: Run['status'],
  error?: string,
): void {
  run.status = status;
  run.updatedAt = now();
  run.error = error;
  host.store.transaction(() => {
    host.store.putRun(run);
    host.store.append(run, `run.${status}`, error ?? `Run ${status}`);
  });
  try {
    host.store.exportRun(run);
  } catch {
    /* SQLite remains authoritative; logs are repaired when reopened. */
  }
}

export function recordAdapterEvent(
  host: Pick<RuntimeBindings, 'store' | 'active' | 'changed'>,
  run: Run,
  event: AdapterEvent,
): void {
  if (!host.active.has(run.id)) return;
  host.store.transaction(() => {
    run.updatedAt = now();
    run.lastActivityAt = now();
    if (run.status === 'starting') run.status = 'running';
    host.store.putRun(run);
    host.store.append(run, event.type, event.summary, event.data);
    if (
      event.type === 'message.delta' &&
      typeof event.data?.text === 'string' &&
      typeof event.data?.messageId === 'string'
    ) {
      const id = `${run.id}:${event.data.messageId}`;
      const existing = host.store.message(id);
      host.store.putMessage({
        id,
        runId: run.id,
        conversationId: run.conversationId,
        role: 'assistant',
        text: (existing?.text ?? '') + event.data.text,
        createdAt: existing?.createdAt ?? now(),
      });
    }
  });
  host.store.exportRun(run);
  host.changed();
}

export async function executeNativeTurn(
  host: RuntimeBindings,
  run: Run,
  controller: AbortController,
  lease: WorkspaceLease,
): Promise<void> {
  let sessionId: string | undefined;
  let bound = false;
  let sessionSettled = false;
  let sessionCleanupConfirmed = false;
  let adapterInvoked = false;
  let runtimeCleanupConfirmed = true;
  let nativeCleanupConfirmed = false;
  const settleSession = (
    status: 'completed' | 'failed' | 'interrupted',
    cleanupConfirmed: boolean,
    cleanupEvidence?: Record<string, unknown>,
    error?: string,
  ): void => {
    if (!sessionId || sessionSettled) return;
    host.delegation.records.finishSession({
      runId: run.id,
      sessionId,
      status,
      cleanupConfirmed,
      ...(cleanupConfirmed && cleanupEvidence ? { cleanupEvidence } : {}),
      ...(error ? { error } : {}),
    });
    sessionSettled = true;
    sessionCleanupConfirmed = cleanupConfirmed;
  };
  const onEvent = (event: AdapterEvent): void => {
    if (event.type === 'session.turn-started') {
      const threadId = typeof event.data?.threadId === 'string' ? event.data.threadId : undefined;
      const turnId = typeof event.data?.turnId === 'string' ? event.data.turnId : undefined;
      if (sessionId && threadId && turnId) {
        host.delegation.records.bindSession({ runId: run.id, sessionId, threadId, turnId });
        bound = true;
      }
    }
    host.event(run, event);
  };
  try {
    host.workspaceOwnership.assert(lease);
    host.workspaceOwnership.stage({ ...lease, phase: 'native-turn' });
    if (!run.executable || !run.executableVersion)
      throw new Error('Run lacks a frozen native executable identity.');
    sessionId = randomUUID();
    host.delegation.records.recordSession({
      id: sessionId,
      runId: run.id,
      role: 'main',
      harness: run.harness ?? 'codex',
      executable: run.executable,
      executableVersion: run.executableVersion,
      model: run.model,
      effort: run.effort,
      allowedTools: [],
      state: 'dispatch-intent',
      ...(run.executionOrigin ? { origin: structuredClone(run.executionOrigin) } : {}),
    });
    const harness = run.harness ?? 'codex';
    host.event(run, {
      type: 'run.started',
      summary: `Connecting to ${harness}`,
      data: { harness, executable: run.executable, executableVersion: run.executableVersion },
    });
    const messages =
      run.recoveryMessages?.map((message) => ({ ...message })) ??
      host.store.messages(run.conversationId).map(({ role, text }) => ({ role, text }));
    if (run.memory?.text) messages.unshift({ role: 'user', text: run.memory.text });
    if (run.projectContext?.value.purpose)
      messages.unshift({
        role: 'user',
        text:
          'Approved project context for this run (JSON; does not override execution or approval policy):\n' +
          JSON.stringify(run.projectContext),
      });
    if (run.workspaceIdentity) assertWorkspaceIdentity(run.workspace, run.workspaceIdentity);
    const adapter = host.nativeAdmission.adapter(
      run.harness ?? 'codex',
      host.routes.adapterForRun(run),
      {
        owner: { kind: 'run', id: run.id },
        runId: run.id,
        sessionId,
        assertCurrent: () => {
          host.workspaceOwnership.assert(lease);
          if (run.workspaceIdentity) assertWorkspaceIdentity(run.workspace, run.workspaceIdentity);
        },
      },
    );
    adapterInvoked = true;
    const result = await adapter.run({
      workspaceIdentity: run.workspaceIdentity,
      executable: run.executable,
      executableVersion: run.executableVersion,
      workspace: run.workspace,
      model: run.model,
      effort: run.effort,
      executionMode: run.executionMode,
      messages,
      signal: controller.signal,
      onEvent,
    });
    nativeCleanupConfirmed = result.status !== 'stop-unconfirmed';
    if (result.status === 'completed' && bound)
      settleSession('completed', true, { adapterStatus: result.status });
    else if (result.status === 'interrupted')
      settleSession('interrupted', true, { adapterStatus: result.status });
    else if (result.status === 'completed')
      settleSession(
        'failed',
        true,
        { adapterStatus: result.status },
        'Native adapter completed without a registered thread and turn identity.',
      );
    else settleSession('failed', false, undefined, 'Native cleanup could not be confirmed.');
    nativeCleanupConfirmed = result.status !== 'stop-unconfirmed';
    host.workspaceOwnership.assert(lease);
    const cleanupUnconfirmed = result.status === 'stop-unconfirmed';
    if (cleanupUnconfirmed) {
      run.cleanupUnconfirmed = true;
      host.finish(
        run,
        'stop-unconfirmed',
        'The harness stopped responding; cleanup could not be confirmed.',
      );
    } else if (result.status === 'completed' && !bound)
      host.finish(
        run,
        'failed',
        'Native adapter completed without a registered thread and turn identity.',
      );
    else host.finish(run, result.status);
    if (result.status === 'completed' && bound && run.checkpoints?.length) {
      try {
        host.workspaceOwnership.stage({ ...lease, phase: 'completed-checkpoint' });
        host.workspaceOwnership.assert(lease);
        host.checkpoints.capture(run, 'completed-turn');
      } catch (cause) {
        runtimeCleanupConfirmed &&= workspaceCleanupConfirmed(cause);
        host.checkpoints.failed(run, cause);
        if (!workspaceCleanupConfirmed(cause)) {
          run.cleanupUnconfirmed = true;
          host.finish(
            run,
            'stop-unconfirmed',
            'Checkpoint process cleanup could not be confirmed.',
          );
        }
      }
    }
  } catch (error) {
    runtimeCleanupConfirmed &&= workspaceCleanupConfirmed(error);
    const message = error instanceof Error ? error.message : 'Harness failed.';
    const trustedFailure = error instanceof AdapterRunFailure;
    const confirmedBeforeDispatch = !adapterInvoked;
    const confirmedSessionCleanup =
      nativeCleanupConfirmed || (sessionSettled && sessionCleanupConfirmed);
    try {
      if (trustedFailure) settleSession('failed', true, error.cleanupEvidence, message);
      else if (nativeCleanupConfirmed)
        settleSession('failed', true, { adapterResultCleanupConfirmed: true }, message);
      else if (confirmedBeforeDispatch)
        settleSession('failed', true, { dispatch: 'not-invoked' }, message);
      else settleSession('failed', false, undefined, message);
    } catch {
      /* The run failure below remains authoritative. */
    }
    nativeCleanupConfirmed = trustedFailure || confirmedBeforeDispatch || confirmedSessionCleanup;
    if (nativeCleanupConfirmed && runtimeCleanupConfirmed) host.finish(run, 'failed', message);
    else {
      run.cleanupUnconfirmed = true;
      host.finish(run, 'stop-unconfirmed', `${message} Process cleanup could not be confirmed.`);
    }
  } finally {
    try {
      const cleanupConfirmed = nativeCleanupConfirmed && runtimeCleanupConfirmed;
      host.workspaceOwnership.release({
        ...lease,
        cleanupConfirmed,
        cleanupEvidence: {
          runId: run.id,
          nativeCleanupConfirmed,
          runtimeCleanupConfirmed,
          durableStatus:
            host.store.runs().find((value) => value.id === run.id)?.status ?? 'unknown',
        },
      });
    } finally {
      host.active.delete(run.id);
      host.changed();
    }
  }
}
