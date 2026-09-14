import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export type GitWorkspace = {
  root: string;
  workspace: string;
  parentBranch: string;
  parentOid: string;
  workspaceHead: string;
  commonDir: string;
  rootIdentity: string;
  workspaceIdentity: string;
  commonDirIdentity: string;
};
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
export type GitDeliveryPlan = { review: GitReview; commitOid: string; commitContent: string };
export type GitDeliveryState = { commitCreated: boolean; merged: boolean };
const MAX_DIFF = 256 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;

function git(
  root: string,
  args: string[],
  input?: string | Buffer | number,
  index?: string,
): Buffer {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  });
  if (index) env.GIT_INDEX_FILE = index;
  try {
    const settings = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'merge.gpgsign=false',
      '-c',
      'core.attributesFile=/dev/null',
    ];
    let filterKeys = Buffer.alloc(0);
    try {
      filterKeys = execFileSync(
        '/usr/bin/git',
        [
          ...settings,
          '-C',
          root,
          'config',
          '--null',
          '--name-only',
          '--get-regexp',
          '^filter\\..*\\.(clean|smudge|process|required)$',
        ],
        { env, timeout: 5_000, maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
    }
    for (const key of filterKeys.toString('utf8').split('\0').filter(Boolean))
      settings.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    return execFileSync('/usr/bin/git', [...settings, '-C', root, ...args], {
      env,
      input: typeof input === 'number' ? undefined : input,
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT,
      stdio: [typeof input === 'number' ? input : 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { stderr?: Buffer; message?: string };
    throw new Error(
      `Git operation failed: ${failure.stderr?.toString().trim().slice(0, 2000) || failure.message || args[0]}`,
      { cause: error },
    );
  }
}
const text = (
  root: string,
  args: string[],
  input?: string | Buffer | number,
  index?: string,
): string => git(root, args, input, index).toString('utf8').trim();
function canonicalDirectory(path: string): string {
  if (resolve(path) !== path || !lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error('Git workspace path is missing or redirected.');
  return path;
}
function directoryIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error('Git directory identity changed.');
  return `${stat.dev}:${stat.ino}`;
}
export function inspectGitWorkspace(root: string, workspace: string): GitWorkspace {
  canonicalDirectory(root);
  canonicalDirectory(join(root, '.worktrees'));
  canonicalDirectory(workspace);
  if (
    dirname(workspace) !== join(root, '.worktrees') ||
    !/^randolph-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      basename(workspace),
    )
  )
    throw new Error('Delivery requires an app-managed conversation worktree.');
  if (
    text(root, ['rev-parse', '--show-toplevel']) !== root ||
    text(workspace, ['rev-parse', '--show-toplevel']) !== workspace
  )
    throw new Error('Git workspace identity changed.');
  const commonDir = realpathSync(
    text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  if (
    commonDir !==
    realpathSync(text(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  )
    throw new Error('Worktree belongs to a different repository.');
  let parentBranch: string;
  try {
    parentBranch = text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch (error) {
    throw new Error('The parent checkout must have an attached branch before review or delivery.', {
      cause: error,
    });
  }
  const parentOid = text(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const workspaceHead = text(workspace, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return {
    root,
    workspace,
    parentBranch,
    parentOid,
    workspaceHead,
    commonDir,
    rootIdentity: directoryIdentity(root),
    workspaceIdentity: directoryIdentity(workspace),
    commonDirIdentity: directoryIdentity(commonDir),
  };
}
function requireIntegrated(workspace: GitWorkspace): void {
  if (workspace.workspaceHead !== workspace.parentOid)
    throw new Error(
      'Integration needed: update the conversation worktree against the current parent, verify, and request a new review.',
    );
}
function safeEntry(workspace: string, name: string): ReturnType<typeof lstatSync> | null {
  if (
    !name ||
    name.startsWith('/') ||
    name.split('/').some((part) => part === '..' || part === '.git')
  )
    throw new Error('Unsupported Git path.');
  const path = join(workspace, name);
  let parent = dirname(path);
  while (parent !== workspace) {
    if (!parent.startsWith(workspace + sep)) throw new Error('Git path escaped the worktree.');
    try {
      if (!lstatSync(parent).isDirectory()) return null;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTDIR'
      )
        return null;
      throw error;
    }
    parent = dirname(parent);
  }
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function decodePaths(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Git filenames must use UTF-8 encoding to be reviewed.');
  }
}
function captureTree(workspace: string, evidenceDir: string): string {
  canonicalDirectory(evidenceDir);
  const index = join(evidenceDir, `review-index-${randomUUID()}`);
  let failure: unknown;
  try {
    git(workspace, ['read-tree', '--empty'], undefined, index);
    const tracked = decodePaths(git(workspace, ['ls-tree', '-r', '-z', 'HEAD']))
      .split('\0')
      .filter(Boolean);
    if (tracked.some((entry) => entry.startsWith('160000 ')))
      throw new Error('Submodule review is not supported; no delivery was attempted.');
    const names = new Set([
      ...tracked.map((entry) => entry.slice(entry.indexOf('\t') + 1)),
      ...decodePaths(
        git(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
      )
        .split('\0')
        .filter(Boolean),
    ]);
    const records: string[] = [];
    for (const name of [...names].sort()) {
      const entry = safeEntry(workspace, name);
      if (!entry) continue;
      if (!entry.isFile() && !entry.isSymbolicLink())
        throw new Error(`Cannot review non-file or nested repository: ${name}`);
      const path = join(workspace, name);
      let oid: string;
      if (entry.isSymbolicLink())
        oid = text(
          workspace,
          ['hash-object', '-w', '--no-filters', '--stdin'],
          readlinkSync(path, { encoding: 'buffer' }),
        );
      else {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const actual = fstatSync(fd);
          if (!actual.isFile() || actual.dev !== entry.dev || actual.ino !== entry.ino)
            throw new Error('Worktree changed while files were being reviewed.');
          oid = text(workspace, ['hash-object', '-w', '--no-filters', '--stdin'], fd);
        } finally {
          closeSync(fd);
        }
      }
      const mode = entry.isSymbolicLink()
        ? '120000'
        : Number(entry.mode) & 0o111
          ? '100755'
          : '100644';
      records.push(`${mode} ${oid}\t${name}\0`);
    }
    git(workspace, ['update-index', '-z', '--index-info'], records.join(''), index);
    return text(workspace, ['write-tree'], undefined, index);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (workspaceCleanupConfirmed(failure)) {
      rmSync(index, { force: true });
      rmSync(`${index}.lock`, { force: true });
    }
  }
}
function sameIdentity(
  actual: GitWorkspace,
  expected: GitWorkspace,
  allowDeliveredOid?: string,
): void {
  if (
    actual.root !== expected.root ||
    actual.workspace !== expected.workspace ||
    actual.commonDir !== expected.commonDir ||
    actual.rootIdentity !== expected.rootIdentity ||
    actual.workspaceIdentity !== expected.workspaceIdentity ||
    actual.commonDirIdentity !== expected.commonDirIdentity ||
    actual.parentBranch !== expected.parentBranch ||
    actual.workspaceHead !== expected.workspaceHead ||
    (actual.parentOid !== expected.parentOid && actual.parentOid !== allowDeliveredOid)
  )
    throw new Error(
      'Review is stale: the parent branch or worktree identity changed. Request a new review.',
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
function requireCleanParent(root: string, workspace: string): void {
  const registered = git(root, ['worktree', 'list', '--porcelain', '-z'])
    .toString('utf8')
    .split('\0')
    .filter((row) => row.startsWith('worktree '))
    .map((row) => row.slice(9));
  const common = realpathSync(
    text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const exclusions = registered
    .filter((path) => {
      if (
        dirname(path) !== join(root, '.worktrees') ||
        !/^randolph-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          basename(path),
        )
      )
        return false;
      try {
        canonicalDirectory(path);
        return (
          text(path, ['rev-parse', '--show-toplevel']) === path &&
          realpathSync(text(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ===
            common
        );
      } catch (error) {
        if (!workspaceCleanupConfirmed(error)) throw error;
        return false;
      }
    })
    .map((path) => `:(exclude)${relative(root, path).split(sep).join('/')}`);
  if (!registered.includes(workspace))
    throw new Error('Conversation workspace registration changed.');
  if (
    git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z', '--', '.', ...exclusions])
      .length
  )
    throw new Error(
      'The parent checkout has uncommitted changes. Preserve or commit them outside Randolph, then request delivery again.',
    );
}
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

export {
  git as runSafeGit,
  captureTree as captureGitTree,
  requireCleanParent as assertCleanGitParent,
};
