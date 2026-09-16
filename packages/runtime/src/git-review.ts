import { git } from './git-execution.js';
import {
  captureTree,
  inspectGitWorkspace,
  sameIdentity,
  type GitWorkspace,
} from './git-workspace-snapshot.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { randomUUID } from 'node:crypto';

export type GitReviewFile = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};
export type GitReview = GitWorkspace & {
  id: string;
  evidenceDir: string;
  treeOid: string;
  files: GitReviewFile[];
  diff: string;
  truncated: boolean;
};
const MAX_DIFF = 256 * 1024;
function requireIntegrated(workspace: GitWorkspace): void {
  if (workspace.workspaceHead !== workspace.parentOid)
    throw new Error(
      'Integration needed: update the conversation worktree against the current parent, verify, and request a new review.',
    );
}
export function createGitReview(root: string, workspace: string, evidenceDir: string): GitReview {
  const inspection = inspectGitWorkspace(root, workspace);
  requireIntegrated(inspection);
  const treeOid = captureTree(workspace, evidenceDir);
  if (captureTree(workspace, evidenceDir) !== treeOid)
    throw new Error('Worktree changed while review was being prepared. Try again.');
  sameIdentity(inspectGitWorkspace(root, workspace), inspection);
  const statuses = git(workspace, [
    'diff-tree',
    '--no-commit-id',
    '--no-renames',
    '-r',
    '--name-status',
    '-z',
    inspection.parentOid,
    treeOid,
  ])
    .toString('utf8')
    .split('\0');
  const counts = git(workspace, [
    'diff-tree',
    '--no-commit-id',
    '--no-renames',
    '-r',
    '--numstat',
    '-z',
    inspection.parentOid,
    treeOid,
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const files: GitReviewFile[] = counts.map((row, index) => {
    const first = row.indexOf('\t');
    const second = row.indexOf('\t', first + 1);
    const added = row.slice(0, first);
    const deleted = row.slice(first + 1, second);
    return {
      path: row.slice(second + 1),
      status: statuses[index * 2] ?? 'M',
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
      binary: added === '-' || deleted === '-',
    };
  });
  let diff: Buffer;
  let truncated = false;
  try {
    diff = git(workspace, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--binary',
      inspection.parentOid,
      treeOid,
      '--',
    ]);
  } catch (error) {
    if (
      !workspaceCleanupConfirmed(error) ||
      !(error instanceof Error) ||
      !/ENOBUFS|maxBuffer/.test(error.message)
    )
      throw error;
    diff = Buffer.from('Diff exceeds the display limit. Review individual files externally.');
    truncated = true;
  }
  truncated ||= diff.length > MAX_DIFF;
  return {
    ...inspection,
    id: randomUUID(),
    evidenceDir,
    treeOid,
    files,
    diff: diff.subarray(0, MAX_DIFF).toString('utf8'),
    truncated,
  };
}

export type { GitWorkspace };
export type { GitDeliveryPlan, GitDeliveryState } from './git-delivery.js';
export { inspectGitWorkspace };
export {
  cleanupGitDelivery,
  commitGitDelivery,
  createGitDeliveryPlan,
  deliverGitReview,
  mergeGitDelivery,
  reconcileGitDelivery,
} from './git-delivery.js';
export { runSafeGit } from './git-execution.js';
export { assertCleanGitParent, captureGitTree } from './git-workspace-snapshot.js';
