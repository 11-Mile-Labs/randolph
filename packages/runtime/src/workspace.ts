import { workspaceCleanupConfirmed } from './workspace-operation.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function git(root: string, args: string[]): string {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith('GIT_') &&
      !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].includes(key)
    )
      delete env[key as keyof typeof env];
  const settings = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.attributesFile=/dev/null',
  ];
  let filterKeys = '';
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
      { env, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  for (const key of filterKeys.split('\0').filter(Boolean))
    settings.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  return execFileSync('/usr/bin/git', [...settings, '-C', root, ...args], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export function canonicalProject(path: string): string {
  const root = realpathSync(path);
  try {
    return realpathSync(git(root, ['rev-parse', '--show-toplevel']));
  } catch (error) {
    if (!workspaceCleanupConfirmed(error)) throw error;
    return root;
  }
}
export function plannedConversationWorkspace(
  root: string,
  conversationId: string,
  previous?: string,
): string {
  if (previous) return previous;
  try {
    git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch (error) {
    if (!workspaceCleanupConfirmed(error)) throw error;
    return root;
  }
  return join(root, '.worktrees', `randolph-${conversationId}`);
}
export function prepareWorkspace(root: string, conversationId: string, previous?: string): string {
  if (realpathSync(root) !== root)
    throw new Error('Project root changed. Re-add the project before continuing.');
  const base = join(root, '.worktrees');
  const defaultPath = join(base, `randolph-${conversationId}`);
  const verify = (path: string): string => {
    if (
      dirname(path) !== base ||
      !/^randolph-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        basename(path),
      )
    )
      throw new Error('Conversation workspace is outside its app-managed project directory.');
    if (realpathSync(base) !== base || realpathSync(path) !== path)
      throw new Error('Conversation workspace was redirected outside its original location.');
    const actual = realpathSync(git(path, ['rev-parse', '--show-toplevel']));
    const common = realpathSync(
      git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    const expectedCommon = realpathSync(
      git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    if (actual !== path || common !== expectedCommon)
      throw new Error('Conversation workspace no longer belongs to this project.');
    return path;
  };
  if (previous) {
    if (previous === root) return root;
    if (!existsSync(previous))
      throw new Error(
        'Conversation workspace is missing or changed. Create a new conversation; history is not restarted automatically.',
      );
    return verify(previous);
  }
  let head: string;
  try {
    head = git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch (error) {
    if (!workspaceCleanupConfirmed(error)) throw error;
    return root;
  }
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base)
    throw new Error('Project worktree directory must be inside the repository, without a symlink.');
  // A process may have exited after Git created this exact conversation workspace.
  // Reuse only the registered location and repository identity, without recreating it.
  if (existsSync(defaultPath)) return verify(defaultPath);
  git(root, ['worktree', 'add', '--detach', '--no-checkout', defaultPath, head]);
  // Resolve conditional Git configuration in the new worktree before reading files.
  git(defaultPath, ['reset', '--hard', head]);
  return verify(defaultPath);
}
