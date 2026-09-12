import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function git(root: string, args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].includes(key)) delete env[key as keyof typeof env];
  const settings = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.attributesFile=/dev/null'];
  let filterKeys = '';
  try {
    filterKeys = execFileSync('/usr/bin/git', [...settings, '-C', root, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { env, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  for (const key of filterKeys.split('\0').filter(Boolean)) settings.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  return execFileSync('/usr/bin/git', [...settings, '-C', root, ...args], { env, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function canonicalProject(path: string): string {
  const root = realpathSync(path);
  try { return realpathSync(git(root, ['rev-parse', '--show-toplevel'])); }
  catch { return root; }
}
export function prepareWorkspace(root: string, conversationId: string, previous?: string): string {
  if (realpathSync(root) !== root) throw new Error('Project root changed. Re-add the project before continuing.');
  const base = join(root, '.worktrees');
  const path = join(base, `randolph-${conversationId}`);
  const verify = (): string => {
    if (realpathSync(base) !== base || realpathSync(path) !== path) throw new Error('Conversation workspace was redirected outside its original location.');
    const actual = realpathSync(git(path, ['rev-parse', '--show-toplevel']));
    const common = realpathSync(git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const expectedCommon = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (actual !== path || common !== expectedCommon) throw new Error('Conversation workspace no longer belongs to this project.');
    return path;
  };
  if (previous) {
    if (previous === root) return root;
    if (previous !== path || !existsSync(path)) throw new Error('Conversation workspace is missing or changed. Create a new conversation; history is not restarted automatically.');
    return verify();
  }
  let head: string;
  try { head = git(root, ['rev-parse', '--verify', 'HEAD']); }
  catch { return root; }
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base) throw new Error('Project worktree directory must be inside the repository, without a symlink.');
  // A process may have exited after Git created this exact conversation workspace.
  // Reuse only the registered location and repository identity, without recreating it.
  if (existsSync(path)) return verify();
  git(root, ['worktree', 'add', '--detach', '--no-checkout', path, head]);
  // Resolve conditional Git configuration in the new worktree before reading files.
  git(path, ['reset', '--hard', head]);
  return verify();
}
