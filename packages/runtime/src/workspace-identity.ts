import { lstatSync, realpathSync } from 'node:fs';
import type { WorkspaceIdentity } from './contracts.js';

export function workspaceIdentity(path: string): WorkspaceIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path)
    throw new Error('Execution requires a canonical workspace directory.');
  return { device: stat.dev, inode: stat.ino };
}

export function assertWorkspaceIdentity(path: string, expected: WorkspaceIdentity): void {
  const actual = workspaceIdentity(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode)
    throw new Error(
      'The workspace directory changed before dispatch. Re-add the project before continuing.',
    );
}
