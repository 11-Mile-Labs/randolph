import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckCommand } from './verification.js';

export function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function manifest(workspace: string, name: string): Promise<string | undefined> {
  const directory = await lstat(workspace);
  if (!directory.isDirectory())
    throw new Error('Verification workspace must be a directory without a symbolic link.');
  const path = join(workspace, name);
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile())
    throw new Error(`${name} must be a regular manifest file without a symbolic link.`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      !sameFile(before, opened) ||
      !sameFile(directory, await lstat(workspace))
    )
      throw new Error(`${name} changed while being opened.`);
    if (opened.size > 1024 * 1024) throw new Error(`${name} exceeds the 1 MiB manifest limit.`);
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > 1024 * 1024) throw new Error(`${name} exceeds the 1 MiB manifest limit.`);
    const after = await file.stat();
    const current = await lstat(path);
    if (
      !current.isFile() ||
      !sameFile(opened, current) ||
      !sameFile(directory, await lstat(workspace)) ||
      before.size !== after.size ||
      after.size !== total ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error(`${name} changed while being read.`);
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function hasFile(workspace: string, name: string): Promise<boolean> {
  try {
    const file = await lstat(join(workspace, name));
    if (!file.isFile())
      throw new Error(`${name} must be a regular lockfile without a symbolic link.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function detectVerificationCommands(workspace: string): Promise<CheckCommand[]> {
  const commands: CheckCommand[] = [];
  const add = (id: string, command: string, args: string[]): void => {
    commands.push({ id, label: [command, ...args].join(' '), command, args });
  };
  for (const name of ['package.json', 'go.mod', 'pyproject.toml']) {
    try {
      const source = await manifest(workspace, name);
      if (source === undefined) continue;
      if (name === 'package.json') {
        let value: unknown;
        try {
          value = JSON.parse(source);
        } catch {
          throw new Error('package.json is not valid JSON.');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('package.json must be an object.');
        const { scripts, packageManager } = value as {
          scripts?: unknown;
          packageManager?: unknown;
        };
        if (
          packageManager !== undefined &&
          (typeof packageManager !== 'string' || !/^pnpm(?:@|$)/.test(packageManager))
        ) {
          throw new Error('Only installed pnpm package-manager verification is supported.');
        }
        if (
          packageManager === undefined &&
          !(await hasFile(workspace, 'pnpm-lock.yaml')) &&
          ((await hasFile(workspace, 'package-lock.json')) ||
            (await hasFile(workspace, 'npm-shrinkwrap.json')) ||
            (await hasFile(workspace, 'yarn.lock')) ||
            (await hasFile(workspace, 'bun.lock')) ||
            (await hasFile(workspace, 'bun.lockb')))
        ) {
          throw new Error(
            'This project declares a different package-manager lockfile; only installed pnpm verification is supported.',
          );
        }
        if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
          for (const script of ['lint', 'typecheck', 'build', 'test']) {
            const content = (scripts as Record<string, unknown>)[script];
            if (typeof content === 'string' && content.trim())
              add(`pnpm-${script}`, 'pnpm', ['run', script]);
          }
        }
      } else if (name === 'go.mod') {
        if (/^\s*module\s+\S+/m.test(source)) {
          for (const command of ['build', 'vet', 'test'])
            add(`go-${command}`, 'go', [command, './...']);
        } else {
          throw new Error('go.mod has no module declaration.');
        }
      } else if (/^\s*\[tool\.pytest\.ini_options\]\s*(?:#.*)?$/m.test(source)) {
        add('python-pytest', 'python3', ['-m', 'pytest']);
      }
    } catch (error) {
      commands.push({
        id: `unsupported-${name}`,
        label: `${name} verification unavailable`,
        command: '',
        args: [],
        unsupportedReason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return commands;
}
