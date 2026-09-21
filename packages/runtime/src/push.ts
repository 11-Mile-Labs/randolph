import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CleanupUnconfirmedError, git, requiredGit } from './push-git-transport.js';
import type { PushOptions } from './push-types.js';

// The cancellable Git transport lives in push-git-transport.ts and the caller-supplied options
// shape in push-types.ts, so the transport can import them without referring back to this module.
// These re-exports keep every established push import intact, and CleanupUnconfirmedError keeps a
// single class identity so instanceof still holds across both modules.
export { CleanupUnconfirmedError } from './push-git-transport.js';
export type { PushOptions } from './push-types.js';

export interface PushPlan {
  readonly root: string;
  readonly rootIdentity: string;
  readonly commonDir: string;
  readonly commonDirIdentity: string;
  readonly originUrl: string;
  readonly branch: string;
  readonly localOid: string;
  readonly remoteOid: string | null;
  readonly createdAt: string;
}
export interface PushState {
  status: 'ready' | 'pushed' | 'stale' | 'diverged' | 'uncertain';
  localOid: string;
  remoteOid: string | null;
  error?: string;
  cleanupVerified?: false;
}
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

async function identity(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || (await realpath(path)) !== path)
    throw new Error('Project or Git directory was redirected.');
  return `${info.dev}:${info.ino}`;
}

function validateTransport(url: string, options: PushOptions): void {
  if (!url || /[\0\r\n]/.test(url)) throw new Error('Origin URL is invalid.');
  if (isAbsolute(url)) {
    if (!options.allowLocalTransport)
      throw new Error('Local origin transport requires explicit fixture authorization.');
    return;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s].*$/.test(url) && !url.includes('://')) {
    if (!options.sshKeyPath)
      throw new Error('SSH origin requires an explicitly configured unattended identity path.');
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Unsupported origin transport. Use SSH or HTTPS.');
  }
  if (
    !['https:', 'ssh:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.password ||
    (parsed.protocol === 'https:' && parsed.username)
  )
    throw new Error('Unsafe origin transport or embedded credentials are not supported.');
  if (parsed.protocol === 'ssh:' && !options.sshKeyPath)
    throw new Error('SSH origin requires an explicitly configured unattended identity path.');
}

async function inspect(
  root: string,
  options: PushOptions,
): Promise<Omit<PushPlan, 'remoteOid' | 'createdAt'>> {
  const rootIdentity = await identity(root);
  if ((await requiredGit(root, ['rev-parse', '--show-toplevel'], options)) !== root)
    throw new Error('Push requires the registered project root.');
  const commonDir = await realpath(
    await requiredGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options),
  );
  const commonDirIdentity = await identity(commonDir);
  const branch = await requiredGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  await requiredGit(root, ['check-ref-format', `refs/heads/${branch}`], options);
  const localOid = await requiredGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], options);
  const urls = await requiredGit(root, ['config', '--get-all', 'remote.origin.url'], options);
  if (urls.split('\n').length !== 1) throw new Error('Origin must have exactly one URL.');
  const pushUrls = await git(root, ['config', '--get-all', 'remote.origin.pushurl'], options);
  if (pushUrls.code !== 1) throw new Error('Separate origin push URLs are not supported.');
  validateTransport(urls, options);
  if (!OID.test(localOid)) throw new Error('Local commit object ID is invalid.');
  return { root, rootIdentity, commonDir, commonDirIdentity, originUrl: urls, branch, localOid };
}

async function isolated<T>(
  plan: Pick<PushPlan, 'commonDir'>,
  options: PushOptions,
  action: (scratch: string, env: NodeJS.ProcessEnv) => Promise<T>,
  useObjects = true,
): Promise<T> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'randolph-origin-')));
  let preserve = false;
  try {
    await requiredGit(scratch, ['init', '--bare', '--template=', '.'], options);
    const env = useObjects
      ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(plan.commonDir, 'objects') }
      : {};
    return await action(scratch, env);
  } catch (error) {
    preserve = error instanceof CleanupUnconfirmedError;
    throw error;
  } finally {
    if (!preserve) await rm(scratch, { recursive: true, force: true });
  }
}
async function remoteOid(
  plan: PushPlan | Omit<PushPlan, 'remoteOid' | 'createdAt'>,
  options: PushOptions,
): Promise<string | null> {
  validateTransport(plan.originUrl, options);
  if (
    isAbsolute(plan.originUrl) &&
    (await requiredGit(plan.originUrl, ['rev-parse', '--is-bare-repository'], options)) !== 'true'
  )
    throw new Error('Local fixture origin must be a bare repository.');
  return await isolated(
    plan,
    options,
    async (scratch, env) => {
      const output = await requiredGit(
        scratch,
        [
          'ls-remote',
          '--refs',
          '--upload-pack=git-upload-pack',
          '--',
          plan.originUrl,
          `refs/heads/${plan.branch}`,
        ],
        options,
        env,
      );
      if (!output) return null;
      const rows = output.split('\n');
      const [oid, ref] = rows[0].split('\t');
      if (rows.length !== 1 || !OID.test(oid) || ref !== `refs/heads/${plan.branch}`)
        throw new Error('Origin returned an unexpected branch identity.');
      return oid;
    },
    false,
  );
}
async function fastForward(plan: PushPlan, options: PushOptions): Promise<boolean> {
  if (plan.remoteOid === null) return true;
  return await isolated(
    plan,
    options,
    async (scratch, env) =>
      (
        await git(
          scratch,
          ['merge-base', '--is-ancestor', plan.remoteOid!, plan.localOid],
          options,
          env,
        )
      ).code === 0,
  );
}
function matching(actual: Omit<PushPlan, 'remoteOid' | 'createdAt'>, plan: PushPlan): boolean {
  return Object.entries(actual).every(([key, value]) => plan[key as keyof PushPlan] === value);
}
export async function previewOriginPush(
  root: string,
  options: PushOptions = {},
): Promise<PushPlan> {
  const actual = await inspect(root, options);
  const plan: PushPlan = {
    ...actual,
    remoteOid: await remoteOid(actual, options),
    createdAt: new Date().toISOString(),
  };
  if (!matching(await inspect(root, options), plan))
    throw new Error('Project changed while push preview was prepared.');
  if (!(await fastForward(plan, options)))
    throw new Error(
      'Origin diverged or its revision is unavailable locally. Update the project before requesting push.',
    );
  return Object.freeze(plan);
}
export async function reconcileOriginPush(
  plan: PushPlan,
  options: PushOptions = {},
): Promise<PushState> {
  try {
    const current = await remoteOid(plan, options);
    if (current === plan.localOid)
      return { status: 'pushed', localOid: plan.localOid, remoteOid: current };
    const actual = await inspect(plan.root, options);
    if (!matching(actual, plan))
      return {
        status: 'stale',
        localOid: actual.localOid,
        remoteOid: current,
        error: 'Project, branch, commit or origin changed since preview.',
      };
    if (current !== plan.remoteOid)
      return {
        status: 'stale',
        localOid: plan.localOid,
        remoteOid: current,
        error: 'Origin branch changed since preview.',
      };
    if (!(await fastForward(plan, options)))
      return {
        status: 'diverged',
        localOid: plan.localOid,
        remoteOid: current,
        error: 'The approved push is not a proven fast-forward.',
      };
    return { status: 'ready', localOid: plan.localOid, remoteOid: current };
  } catch (error) {
    return {
      status: 'uncertain',
      localOid: plan.localOid,
      remoteOid: null,
      error: error instanceof Error ? error.message : 'Origin outcome could not be confirmed.',
      ...(error instanceof CleanupUnconfirmedError ? { cleanupVerified: false as const } : {}),
    };
  }
}

/** Caller must persist this exact plan after explicit push approval before invoking. */
export async function executeOriginPush(
  plan: PushPlan,
  options: PushOptions = {},
): Promise<PushState> {
  const state = await reconcileOriginPush(plan, options);
  if (state.status !== 'ready') return state;
  try {
    if (!matching(await inspect(plan.root, options), plan))
      return { ...state, status: 'stale', error: 'Project changed before push dispatch.' };
    await isolated(plan, options, async (scratch, env) => {
      // Exact lease is an atomic compare-and-swap, allowed only after proving ancestry.
      // It cannot rewrite history: the leased old revision is an ancestor of localOid.
      await requiredGit(
        scratch,
        [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-follow-tags',
          '--recurse-submodules=no',
          '--receive-pack=git-receive-pack',
          `--force-with-lease=refs/heads/${plan.branch}:${plan.remoteOid ?? ''}`,
          '--',
          plan.originUrl,
          `${plan.localOid}:refs/heads/${plan.branch}`,
        ],
        options,
        env,
      );
    });
  } catch (error) {
    // Unknown process cleanup is terminal for this operation: reconciliation would
    // launch another subprocess and overwrite the evidence we must retain.
    if (error instanceof CleanupUnconfirmedError)
      return {
        status: 'uncertain',
        localOid: plan.localOid,
        remoteOid: null,
        cleanupVerified: false,
        error: error.message,
      };
    const reconciled = await reconcileOriginPush(plan, { ...options, signal: undefined });
    return reconciled.status === 'pushed'
      ? reconciled
      : {
          ...reconciled,
          error: error instanceof Error ? error.message : 'Push failed; reconcile before retry.',
        };
  }
  return await reconcileOriginPush(plan, { ...options, signal: undefined });
}
