import type { GitDeliveryPlan } from './git-delivery.js';
import { runSafeGit } from './git-execution.js';
import { inspectGitWorkspace } from './git-workspace-snapshot.js';
import { assertIdentity, gitText } from './integration-evidence.js';

// Integration preparation lives in integration-plan.ts and application/rollback in
// integration-apply.ts, over the shared record shapes in integration-contracts.ts and the read-only
// checks in integration-evidence.ts, so neither side refers back to this module. These re-exports
// keep every established integration.js import intact.
export type {
  GitIntegrationFile,
  GitIntegrationPlan,
  GitIntegrationResult,
} from './integration-contracts.js';
export { prepareIntegration } from './integration-plan.js';
export { applyIntegration } from './integration-apply.js';

export function reconcileSupersededDelivery(
  root: string,
  workspace: string,
  plan: GitDeliveryPlan,
): { commitCreated: boolean; merged: boolean } {
  const actual = inspectGitWorkspace(root, workspace);
  assertIdentity(
    { ...actual, parentOid: plan.review.parentOid, workspaceHead: plan.review.workspaceHead },
    plan.review,
  );
  if (
    gitText(root, ['hash-object', '-t', 'commit', '--stdin'], plan.commitContent) !==
      plan.commitOid ||
    !plan.commitContent.startsWith(`tree ${plan.review.treeOid}\nparent ${plan.review.parentOid}\n`)
  )
    throw new Error('Invalid original delivery plan.');
  let commitCreated = false;
  let merged = false;
  try {
    commitCreated =
      gitText(root, ['cat-file', 'commit', plan.commitOid]) === plan.commitContent.trim();
  } catch {
    /* No completed commit object. */
  }
  if (commitCreated) {
    try {
      runSafeGit(root, ['merge-base', '--is-ancestor', plan.commitOid, actual.parentOid]);
      merged = true;
    } catch {
      /* Original approval was not merged. */
    }
  }
  return { commitCreated, merged };
}
