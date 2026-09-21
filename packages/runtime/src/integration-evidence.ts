import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { runSafeGit } from './git-execution.js';
import type { GitWorkspace } from './git-workspace-snapshot.js';
import type { GitIntegrationFile } from './integration-contracts.js';

// Only the read-only checks that both preparation and application perform live here: readIndex is
// called by prepareIntegration and by applyIntegration, as are preflightPaths, assertIdentity,
// assertDetached, digest, gitText and the 8 MiB per-file bound. Nothing that mutates the worktree
// is exported from this module; replacement and rollback stay inside integration-apply.ts.
export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const gitText = (
  root: string,
  args: string[],
  input?: string | Buffer,
  index?: string,
): string => runSafeGit(root, args, input, index).toString('utf8').trim();
export const FILE_LIMIT = 8 * 1024 * 1024;

export function assertIdentity(
  actual: GitWorkspace,
  expected: GitWorkspace,
  allowHead?: string,
): void {
  for (const key of [
    'root',
    'workspace',
    'parentBranch',
    'parentOid',
    'commonDir',
    'rootIdentity',
    'workspaceIdentity',
    'commonDirIdentity',
  ] as const) {
    if (actual[key] !== expected[key])
      throw new Error(
        'Integration is stale: project identity or target branch changed. Prepare integration again.',
      );
  }
  if (actual.workspaceHead !== expected.workspaceHead && actual.workspaceHead !== allowHead)
    throw new Error('Integration is stale: the conversation HEAD changed.');
}
export function assertDetached(workspace: string): void {
  if (gitText(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'HEAD')
    throw new Error('Integration requires a detached app-managed worktree; no branch was changed.');
}
export function readIndex(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new Error('Git index is missing or redirected.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function pathState(
  workspace: string,
  name: string,
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(join(workspace, name));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      return undefined;
    throw error;
  }
}
export function preflightPaths(workspace: string, files: GitIntegrationFile[]): void {
  for (const file of files) {
    const current = pathState(workspace, file.path);
    if (current?.isDirectory())
      throw new Error(`Directory-to-file integration requires manual resolution: ${file.path}`);
    if (!file.before && current)
      throw new Error(`Integration would overwrite an ignored or unrelated file: ${file.path}`);
    let parent = dirname(join(workspace, file.path));
    while (parent !== workspace) {
      if (!parent.startsWith(workspace + sep))
        throw new Error('Integration path left its worktree.');
      try {
        if (!lstatSync(parent).isDirectory())
          throw new Error(`Integration path is blocked or redirected: ${file.path}`);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
        )
          throw error;
      }
      parent = dirname(parent);
    }
  }
}
