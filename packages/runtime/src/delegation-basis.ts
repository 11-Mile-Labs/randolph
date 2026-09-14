import { createHash } from 'node:crypto';
import type { Run } from './contracts.js';
import type { DelegationPlanRevision } from './delegation-records.js';
import { Checkpoints } from './checkpoints.js';
import { captureGitTree } from './git-review.js';
import { assertWorkspaceIdentity } from './workspace-identity.js';
import { Store } from './store.js';

export function retainedDelegationBasis(store: Store, run: Run): Record<string, unknown> {
  const checkpoint = run.checkpoints?.at(-1);
  if (
    run.status !== 'completed' ||
    run.cleanupUnconfirmed ||
    !checkpoint ||
    checkpoint.boundary !== 'completed-turn' ||
    !run.workspaceIdentity
  )
    throw new Error(
      'A completed native turn, confirmed cleanup, and retained source checkpoint are required.',
    );
  new Checkpoints(store).selected(run.id, checkpoint.digest);
  const messages = run.recoveryMessages
    ? [
        ...run.recoveryMessages,
        ...store
          .messages(run.conversationId)
          .filter(
            (message) =>
              message.runId === run.id &&
              message.role === 'assistant' &&
              !message.id.startsWith(`${run.id}:recovery:`),
          )
          .map(({ role, text }) => ({ role, text })),
      ]
    : store.messages(run.conversationId).map(({ role, text }) => ({ role, text }));
  const context = {
    projectContext: run.projectContext,
    memory: run.memory,
    messages,
    harness: run.harness,
    executable: run.executable,
    executableVersion: run.executableVersion,
    model: run.model,
    effort: run.effort,
    enabledHarnessRoutes: run.enabledHarnessRoutes,
    harnessAuthorizationRevision: run.harnessAuthorizationRevision,
  };
  return {
    schemaVersion: 1,
    checkpointDigest: checkpoint.digest,
    sourceTreeOid: checkpoint.snapshotTreeOid,
    workspaceIdentity: run.workspaceIdentity,
    contextDigest: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
  };
}

export function assertDelegationBasis(store: Store, run: Run, plan: DelegationPlanRevision): void {
  const expected = retainedDelegationBasis(store, run);
  if (
    Object.keys(plan.basis).length !== Object.keys(expected).length ||
    Object.entries(expected).some(
      ([key, value]) => JSON.stringify(plan.basis[key]) !== JSON.stringify(value),
    )
  )
    throw new Error(
      'Proposal source or context changed. Prepare a new proposal basis before approval.',
    );
  assertWorkspaceIdentity(run.workspace, run.workspaceIdentity!);
  const actualTree = captureGitTree(run.workspace, store.runDirectory(run));
  assertWorkspaceIdentity(run.workspace, run.workspaceIdentity!);
  if (actualTree !== expected.sourceTreeOid)
    throw new Error(
      'Source files changed after this proposal was prepared. A new source basis is required.',
    );
}
