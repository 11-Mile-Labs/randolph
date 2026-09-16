import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { runSafeGit } from './git-execution.js';
import { inspectRegularFile } from './checkpoint-file-io.js';
import {
  FILE_LIMIT,
  PATH_LIMIT,
  SNAPSHOT_LIMIT,
  type StoredCheckpointManifest,
} from './checkpoint-manifest.js';

export function gitText(
  root: string,
  args: string[],
  input?: string | Buffer,
  index?: string,
): string {
  return runSafeGit(root, args, input, index).toString('utf8').trim();
}

export function validateSnapshot(root: string, treeOid: string): void {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(
    runSafeGit(root, ['ls-tree', '-r', '-l', '-z', treeOid]),
  );
  const rows = raw.split('\0').filter(Boolean);
  if (rows.length > PATH_LIMIT)
    throw new Error('Checkpoint snapshot exceeds the supported 100,000 path limit.');
  let total = 0;
  for (const row of rows) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\s+([0-9]+)\t([^\0]+)$/.exec(row);
    if (!match)
      throw new Error('Checkpoint snapshots do not support submodules or special Git entries.');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > FILE_LIMIT)
      throw new Error(`Checkpoint file exceeds the supported 64 MiB limit: ${match[4]}`);
    total += size;
    if (total > SNAPSHOT_LIMIT)
      throw new Error('Checkpoint snapshot exceeds the supported 512 MiB content limit.');
  }
}

export function safeGitInit(
  destination: string,
  objectFormat: StoredCheckpointManifest['objectFormat'],
): void {
  const env = safeGitEnvironment();
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'init.templateDir=',
      'init',
      '--quiet',
      `--object-format=${objectFormat}`,
      destination,
    ],
    {
      env,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );
}

export function safeGitEnvironment(): NodeJS.ProcessEnv {
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
  return env;
}

export function verifyStandalonePack(
  root: string,
  packPath: string,
  indexPath: string,
  packHash: string,
  manifest: StoredCheckpointManifest,
): void {
  const proof = join(dirname(packPath), '.pack-proof');
  runSafeGit(root, [
    '-c',
    'init.templateDir=',
    'init',
    '--quiet',
    '--bare',
    `--object-format=${manifest.objectFormat}`,
    proof,
  ]);
  try {
    const proofPack = join(proof, 'objects', 'pack', `pack-${packHash}.pack`);
    const proofIndex = join(proof, 'objects', 'pack', `pack-${packHash}.idx`);
    copyFileSync(packPath, proofPack, constants.COPYFILE_EXCL);
    copyFileSync(indexPath, proofIndex, constants.COPYFILE_EXCL);
    gitText(proof, ['verify-pack', '-s', proofIndex]);
    gitText(proof, ['cat-file', '-e', `${manifest.baseCommitOid}^{commit}`]);
    gitText(proof, ['cat-file', '-e', `${manifest.snapshotTreeOid}^{tree}`]);
    gitText(proof, ['cat-file', '-e', `${manifest.snapshotCommitOid}^{commit}`]);
    gitText(proof, ['fsck', '--connectivity-only', '--no-reflogs', manifest.snapshotCommitOid]);
  } finally {
    rmSync(proof, { force: true, recursive: true });
  }
}

export type TreeEntry = {
  mode: '100644' | '100755' | '120000';
  oid: string;
  path: string;
  size: number;
};

export function treeEntries(root: string, treeOid: string): TreeEntry[] {
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(
    runSafeGit(root, ['ls-tree', '-r', '-l', '-z', treeOid]),
  );
  return raw
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\s+([0-9]+)\t([^\0]+)$/.exec(
        row,
      );
      if (!match) throw new Error('Checkpoint contains a submodule or unsupported Git entry.');
      const path = match[4];
      if (
        path.startsWith('/') ||
        path
          .split('/')
          .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
      )
        throw new Error('Checkpoint contains an unsafe Git path.');
      const size = Number(match[3]);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > FILE_LIMIT ||
        (match[1] === '120000' && size > 4096)
      )
        throw new Error('Checkpoint contains an oversized Git object.');
      return { mode: match[1] as TreeEntry['mode'], oid: match[2], path, size };
    });
}

/**
 * Standalone and linked restoration materialize blobs identically except for two
 * deliberately different policies: the redirected-parent message and the
 * post-write inspection. Linked restore's inspection is NOT the same check as
 * `inspectRegularFile` - it omits the post-read mtime equality check - so the
 * policy is passed explicitly rather than unified. Tightening or loosening
 * either side is a rejection-behavior change, not a refactor.
 */
export type BlobRestorePolicy = {
  redirectedParentMessage: string;
  inspectRestoredFile: (path: string, limit: number, label: string) => { bytes: number };
};

export const STANDALONE_RESTORE_POLICY: BlobRestorePolicy = {
  redirectedParentMessage: 'Checkpoint path parent was redirected during restore.',
  inspectRestoredFile: inspectRegularFile,
};

export function materializeBlob(
  root: string,
  entry: TreeEntry,
  policy: BlobRestorePolicy = STANDALONE_RESTORE_POLICY,
): void {
  const path = join(root, entry.path);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== parent) throw new Error(policy.redirectedParentMessage);
  if (entry.mode === '120000') {
    const target = runSafeGit(root, ['cat-file', 'blob', entry.oid]);
    if (target.length !== entry.size || target.includes(0))
      throw new Error('Checkpoint symlink target is invalid.');
    symlinkSync(target, path);
    return;
  }
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    entry.mode === '100755' ? 0o755 : 0o644,
  );
  try {
    execFileSync(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.attributesFile=/dev/null',
        '-C',
        root,
        'cat-file',
        'blob',
        entry.oid,
      ],
      {
        env: safeGitEnvironment(),
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', fd, 'pipe'],
        timeout: 30_000,
      },
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (
    policy.inspectRestoredFile(path, FILE_LIMIT, `Restored file ${entry.path}`).bytes !== entry.size
  )
    throw new Error('Restored Git blob has an unexpected size.');
}
