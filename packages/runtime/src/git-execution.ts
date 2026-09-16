import { execFileSync } from 'node:child_process';

const MAX_OUTPUT = 16 * 1024 * 1024;

export function git(
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
export const text = (
  root: string,
  args: string[],
  input?: string | Buffer | number,
  index?: string,
): string => git(root, args, input, index).toString('utf8').trim();

export { git as runSafeGit };
