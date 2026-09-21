import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from './codex.js';
import { Journal } from './evidence.js';
import { restoreCheckpoint, verifyCheckpoint } from './checkpoint.js';

export type RestartApproval = {
  action: 'restart';
  source: 'human';
  decision: 'approved';
  conversationId: string;
  previousRunId: string;
  checkpointDigest: string;
};

export function requireRestartApproval(
  current: { conversationId: string; previousRunId: string; checkpointDigest: string },
  approval?: RestartApproval,
): void {
  if (
    !approval ||
    approval.action !== 'restart' ||
    approval.source !== 'human' ||
    approval.decision !== 'approved' ||
    approval.conversationId !== current.conversationId ||
    approval.previousRunId !== current.previousRunId ||
    approval.checkpointDigest !== current.checkpointDigest
  )
    throw new Error('Explicit checkpoint-specific human Restart required');
}

/** A fresh journal is an exclusive attempt: reopening this history never calls launch again. */
export async function restartFromCheckpoint(options: {
  checkpointDir: string;
  source: Journal;
  next: Journal;
  destination: string;
  conversationId: string;
  previousRunId: string;
  approval?: RestartApproval;
  launch: (restored: Awaited<ReturnType<typeof restoreCheckpoint>>, runId: string) => Promise<void>;
}): Promise<string> {
  const manifest = await verifyCheckpoint(options.checkpointDir, options.source);
  const checkpointDigest = hash(readFileSync(join(options.checkpointDir, 'manifest.json'), 'utf8'));
  requireRestartApproval(
    {
      conversationId: options.conversationId,
      previousRunId: options.previousRunId,
      checkpointDigest,
    },
    options.approval,
  );
  if (
    manifest.metadata.runId !== options.previousRunId ||
    manifest.metadata.conversationId !== options.conversationId
  )
    throw new Error('Checkpoint belongs to another conversation or run');
  const prior = options.source.records.findLast(
    (event) => event.type === 'lifecycle.state',
  )?.details;
  if (
    (prior?.state !== 'stopped' && prior?.state !== 'interrupted') ||
    prior.runId !== options.previousRunId
  )
    throw new Error('Only the matching stopped or interrupted run can restart');
  if (options.next.records.length)
    throw new Error('Restart journal already used; reopening never dispatches');
  const runId = randomUUID();
  options.next.append('restart.intent', 'Explicit restart creates a new linked run', {
    runId,
    previousRunId: options.previousRunId,
    conversationId: options.conversationId,
    checkpointDigest,
    unfinishedWorkAfterCheckpoint: 'lost',
    context: manifest.metadata,
  });
  try {
    const restored = await restoreCheckpoint(
      options.checkpointDir,
      options.destination,
      options.source,
    );
    options.next.append(
      'restart.restored',
      'Code and retained context restored before native dispatch',
      { runId, checkpointDigest },
    );
    options.next.append('lifecycle.state', 'Explicitly authorized native restart', {
      state: 'running',
      runId,
    });
    await options.launch(restored, runId);
    options.next.append('lifecycle.state', 'Restart verification completed', {
      state: 'stopped',
      runId,
    });
    return runId;
  } catch (error) {
    options.next.append('lifecycle.state', 'Restart interrupted; reopening is read-only', {
      state: 'interrupted',
      runId,
    });
    throw error;
  }
}

export function appendRunEvent(
  journal: Journal,
  currentRunId: string,
  event: { runId: string; type: string; details: Record<string, unknown> },
): void {
  if (event.runId !== currentRunId) throw new Error('Late event belongs to a different run');
  journal.append('run.event', 'Observed event for the active run', { ...event });
}
