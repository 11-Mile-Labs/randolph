import { git, text } from './git-execution.js';
import { workspaceCleanupConfirmed } from './workspace-operation.js';
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
export function canonicalDirectory(path: string): string {
  if (resolve(path) !== path || !lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error('Git workspace path is missing or redirected.');
  return path;
}
export function directoryIdentity(path: string): string {
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
export function captureTree(workspace: string, evidenceDir: string): string {
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
export function sameIdentity(
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
export function requireCleanParent(root: string, workspace: string): void {
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

export { captureTree as captureGitTree, requireCleanParent as assertCleanGitParent };
