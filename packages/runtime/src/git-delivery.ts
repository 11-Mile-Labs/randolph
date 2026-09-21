import { git, text } from './git-execution.js';
import {
  canonicalDirectory,
  captureTree,
  directoryIdentity,
  inspectGitWorkspace,
  requireCleanParent,
  sameIdentity,
  type GitWorkspace,
} from './git-workspace-snapshot.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GitReview } from './git-review.js';

export type GitDeliveryPlan = { review: GitReview; commitOid: string; commitContent: string };
export type GitDeliveryState = { commitCreated: boolean; merged: boolean };
function validatePlan(root: string, workspace: string, plan: GitDeliveryPlan): void {
  if (
    plan.review.root !== root ||
    plan.review.workspace !== workspace ||
    text(root, ['hash-object', '-t', 'commit', '--stdin'], plan.commitContent) !== plan.commitOid
  )
    throw new Error('Invalid delivery plan.');
  if (
    !plan.commitContent.startsWith(`tree ${plan.review.treeOid}\nparent ${plan.review.parentOid}\n`)
  )
    throw new Error('Delivery plan does not match the reviewed tree and parent.');
}
function assertReviewedTree(root: string, workspace: string, review: GitReview): void {
  sameIdentity(inspectGitWorkspace(root, workspace), review);
  if (
    captureTree(workspace, review.evidenceDir) !== review.treeOid ||
    captureTree(workspace, review.evidenceDir) !== review.treeOid
  )
    throw new Error('Review is stale: worktree files changed. Verify and request a new review.');
  sameIdentity(inspectGitWorkspace(root, workspace), review);
  requireCleanParent(root, workspace);
}
function identity(root: string): string {
  const get = (key: string): string => {
    try {
      return text(root, ['config', '--get', key]);
    } catch (error) {
      if (!workspaceCleanupConfirmed(error)) throw error;
      try {
        return text(root, [
          'config',
          '--file',
          join(homedir(), '.gitconfig'),
          '--includes',
          '--get',
          key,
        ]);
      } catch (error) {
        throw new Error('Configure Git user.name and user.email before delivery.', {
          cause: error,
        });
      }
    }
  };
  const name = get('user.name');
  const email = get('user.email');
  if (!name || !email || /[<>\r\n\0]/.test(name + email))
    throw new Error('Configure a valid Git author name and email before delivery.');
  return `${name} <${email}> ${Math.floor(Date.now() / 1000)} +0000`;
}
export function createGitDeliveryPlan(
  root: string,
  workspace: string,
  review: GitReview,
  message: string,
): GitDeliveryPlan {
  assertReviewedTree(root, workspace, review);
  if (!review.files.length) throw new Error('There are no changes to deliver.');
  if (!message.trim() || message.length > 16_000 || message.includes('\0'))
    throw new Error('Enter a commit message of at most 16,000 characters.');
  const author = identity(root);
  const commitContent = `tree ${review.treeOid}\nparent ${review.parentOid}\nauthor ${author}\ncommitter ${author}\n\n${message.trim()}\n`;
  return {
    review,
    commitContent,
    commitOid: text(root, ['hash-object', '-t', 'commit', '--stdin'], commitContent),
  };
}
function recoveryWorkspace(root: string, workspace: string, expected: GitWorkspace): GitWorkspace {
  try {
    lstatSync(workspace);
    return inspectGitWorkspace(root, workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  canonicalDirectory(root);
  canonicalDirectory(join(root, '.worktrees'));
  if (
    root !== expected.root ||
    workspace !== expected.workspace ||
    dirname(workspace) !== join(root, '.worktrees')
  )
    throw new Error('Worktree identity changed.');
  const registered = git(root, ['worktree', 'list', '--porcelain', '-z'])
    .toString('utf8')
    .split('\0')
    .some((row) => row === `worktree ${workspace}`);
  if (registered)
    throw new Error(
      'Worktree files are missing but Git still registers the workspace. Reconcile manually before cleanup.',
    );
  const commonDir = realpathSync(
    text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  if (text(root, ['rev-parse', '--show-toplevel']) !== root)
    throw new Error('Parent checkout identity changed.');
  const parentBranch = text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return {
    root,
    workspace,
    commonDir,
    parentBranch,
    parentOid: text(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    workspaceHead: expected.workspaceHead,
    rootIdentity: directoryIdentity(root),
    workspaceIdentity: expected.workspaceIdentity,
    commonDirIdentity: directoryIdentity(commonDir),
  };
}
export function reconcileGitDelivery(
  root: string,
  workspace: string,
  plan: GitDeliveryPlan,
): GitDeliveryState {
  validatePlan(root, workspace, plan);
  const actual = recoveryWorkspace(root, workspace, plan.review);
  sameIdentity({ ...actual, parentOid: plan.review.parentOid }, plan.review);
  let commitCreated = false;
  try {
    commitCreated =
      text(root, ['cat-file', 'commit', plan.commitOid]) === plan.commitContent.trim();
  } catch (error) {
    if (!workspaceCleanupConfirmed(error)) throw error; /* The intended object was not created. */
  }
  let merged = false;
  if (commitCreated) {
    try {
      git(root, ['merge-base', '--is-ancestor', plan.commitOid, actual.parentOid]);
      merged = true;
    } catch (error) {
      if (!workspaceCleanupConfirmed(error))
        throw error; /* The approved commit is not in the target branch. */
    }
  }
  return { commitCreated, merged };
}
export function commitGitDelivery(
  root: string,
  workspace: string,
  plan: GitDeliveryPlan,
): { commitOid: string } {
  const state = reconcileGitDelivery(root, workspace, plan);
  if (state.merged) return { commitOid: plan.commitOid };
  assertReviewedTree(root, workspace, plan.review);
  if (
    !state.commitCreated &&
    text(root, ['hash-object', '-w', '-t', 'commit', '--stdin'], plan.commitContent) !==
      plan.commitOid
  )
    throw new Error('Git created an unexpected commit object.');
  return { commitOid: plan.commitOid };
}
export function mergeGitDelivery(
  root: string,
  workspace: string,
  plan: GitDeliveryPlan,
): { commitOid: string; parentOid: string } {
  const state = reconcileGitDelivery(root, workspace, plan);
  if (state.merged)
    return { commitOid: plan.commitOid, parentOid: text(root, ['rev-parse', 'HEAD']) };
  if (!state.commitCreated) throw new Error('The approved commit has not been created yet.');
  assertReviewedTree(root, workspace, plan.review);
  git(root, ['merge', '--ff-only', '--no-edit', '--no-stat', plan.commitOid]);
  if (text(root, ['rev-parse', 'HEAD']) !== plan.commitOid)
    throw new Error('Merge outcome changed; reconcile delivery before continuing.');
  return { commitOid: plan.commitOid, parentOid: plan.commitOid };
}
export function cleanupGitDelivery(
  root: string,
  workspace: string,
  plan: GitDeliveryPlan,
): { cleaned: boolean } {
  if (!reconcileGitDelivery(root, workspace, plan).merged)
    throw new Error('Merge must complete before worktree cleanup.');
  try {
    lstatSync(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cleaned: true };
    throw error;
  }
  const actual = inspectGitWorkspace(root, workspace);
  sameIdentity({ ...actual, parentOid: plan.review.parentOid }, plan.review);
  if (
    captureTree(workspace, plan.review.evidenceDir) !== plan.review.treeOid ||
    captureTree(workspace, plan.review.evidenceDir) !== plan.review.treeOid
  )
    throw new Error('Worktree changed after review; cleanup would delete unreviewed files.');
  sameIdentity(
    { ...inspectGitWorkspace(root, workspace), parentOid: plan.review.parentOid },
    plan.review,
  );
  git(root, ['worktree', 'remove', '--force', '--', workspace]);
  recoveryWorkspace(root, workspace, plan.review);
  return { cleaned: true };
}
export function deliverGitReview(
  root: string,
  workspace: string,
  review: GitReview,
  message: string,
): { commitOid: string; parentOid: string } {
  const plan = createGitDeliveryPlan(root, workspace, review, message);
  commitGitDelivery(root, workspace, plan);
  return mergeGitDelivery(root, workspace, plan);
}
