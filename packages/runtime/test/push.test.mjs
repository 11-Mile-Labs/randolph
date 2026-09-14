import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { previewOriginPush, executeOriginPush, reconcileOriginPush } from '../src/push.ts';

const options = { allowLocalTransport: true };
function git(root, args) {
  return execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      root,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'randolph-push-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'project');
  const origin = join(temporary, 'origin.git');
  await mkdir(root);
  await mkdir(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'value.txt'), 'one\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['remote', 'add', 'origin', origin]);
  return { root, origin, temporary, oid: git(root, ['rev-parse', 'HEAD']) };
}

test(
  'preview does not push; explicit execution publishes the exact branch once',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await previewOriginPush(f.root, options);
    assert.equal(plan.localOid, f.oid);
    assert.equal(plan.remoteOid, null);
    assert.equal(git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).trim(), '');
    const delivered = await executeOriginPush(plan, options);
    assert.equal(delivered.status, 'pushed');
    assert.equal(git(f.origin, ['rev-parse', 'refs/heads/main']), f.oid);
    assert.equal((await reconcileOriginPush(plan, options)).status, 'pushed');
    assert.equal((await executeOriginPush(plan, options)).status, 'pushed');
  },
);

async function commit(root, text) {
  await writeFile(join(root, 'value.txt'), text + '\n');
  git(root, ['add', 'value.txt']);
  git(root, ['commit', '-m', text]);
  return git(root, ['rev-parse', 'HEAD']);
}

test('a proven fast-forward updates only the previewed branch', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await executeOriginPush(await previewOriginPush(f.root, options), options);
  const next = await commit(f.root, 'two');
  const plan = await previewOriginPush(f.root, options);
  assert.equal(plan.remoteOid, f.oid);
  assert.equal((await executeOriginPush(plan, options)).status, 'pushed');
  assert.equal(git(f.origin, ['rev-parse', 'main']), next);
  assert.equal(
    git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/']),
    'refs/heads/main',
  );
});

test(
  'local commit or origin changes invalidate the immutable preview without pushing',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await previewOriginPush(f.root, options);
    assert.ok(Object.isFrozen(plan));
    await commit(f.root, 'unapproved');
    assert.equal((await executeOriginPush(plan, options)).status, 'stale');
    assert.equal(git(f.origin, ['for-each-ref', '--format=%(refname)']), '');
    const fresh = await previewOriginPush(f.root, options);
    git(f.root, ['remote', 'set-url', 'origin', join(f.temporary, 'other.git')]);
    assert.equal((await executeOriginPush(fresh, options)).status, 'stale');
    assert.equal(git(f.origin, ['for-each-ref', '--format=%(refname)']), '');
  },
);

test(
  'remote advancement after preview refuses the original push without overwriting',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await executeOriginPush(await previewOriginPush(f.root, options), options);
    const middle = await commit(f.root, 'middle');
    const latest = await commit(f.root, 'latest');
    const plan = await previewOriginPush(f.root, options);
    git(f.root, ['push', f.origin, `${middle}:refs/heads/main`]);
    const result = await executeOriginPush(plan, options);
    assert.equal(result.status, 'stale');
    assert.equal(result.remoteOid, middle);
    assert.equal(git(f.origin, ['rev-parse', 'main']), middle);
    assert.notEqual(middle, latest);
  },
);

test(
  'divergent histories are rejected even though an exact lease could otherwise overwrite them',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await executeOriginPush(await previewOriginPush(f.root, options), options);
    const local = await commit(f.root, 'local');
    git(f.root, ['checkout', '-b', 'other', f.oid]);
    const remote = await commit(f.root, 'remote');
    git(f.root, ['push', f.origin, `${remote}:refs/heads/main`]);
    git(f.root, ['checkout', 'main']);
    await assert.rejects(previewOriginPush(f.root, options), /diverged|unavailable/i);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), local);
    assert.equal(git(f.origin, ['rev-parse', 'main']), remote);
  },
);

test(
  'transport isolation ignores project URL rewrites and push hooks',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const marker = join(f.temporary, 'must-not-run');
    await mkdir(join(f.root, '.git', 'hooks'), { recursive: true });
    await writeFile(
      join(f.root, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
      { mode: 0o700 },
    );
    git(f.root, ['config', 'url.ext::forbidden-helper.insteadOf', f.origin]);
    git(f.root, ['config', 'remote.origin.receivepack', `touch '${marker}'`]);
    const result = await executeOriginPush(await previewOriginPush(f.root, options), options);
    assert.equal(result.status, 'pushed');
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(marker), false);
  },
);

test(
  'unsafe transports, credential URLs and missing local authorization fail before execution',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(previewOriginPush(f.root), /fixture authorization/i);
    for (const url of [
      'ext::touch forbidden',
      'git://example.invalid/repository',
      'https://token@example.invalid/repository',
      'ssh://git@example.invalid/repository',
    ]) {
      git(f.root, ['remote', 'set-url', 'origin', url]);
      await assert.rejects(previewOriginPush(f.root, options), /transport|credentials|identity/i);
    }
  },
);

test(
  'an aborted execution leaves origin unchanged and reports uncertain outcome for reconciliation',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await previewOriginPush(f.root, options);
    const result = await executeOriginPush(plan, { ...options, signal: AbortSignal.abort() });
    assert.equal(result.status, 'uncertain');
    assert.equal(git(f.origin, ['for-each-ref', '--format=%(refname)']), '');
    assert.equal((await reconcileOriginPush(plan, options)).status, 'ready');
  },
);

test(
  'competing approved fast-forwards from one remote revision cannot overwrite each other',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await executeOriginPush(await previewOriginPush(f.root, options), options);
    const peer = join(f.temporary, 'peer');
    git(f.temporary, ['clone', f.origin, peer]);
    const first = await commit(f.root, 'first writer');
    const second = await commit(peer, 'second writer');
    const plans = await Promise.all([
      previewOriginPush(f.root, options),
      previewOriginPush(peer, options),
    ]);
    assert.ok(plans.every((plan) => plan.remoteOid === f.oid));
    const results = await Promise.all(plans.map((plan) => executeOriginPush(plan, options)));
    assert.equal(results.filter((result) => result.status === 'pushed').length, 1);
    assert.equal(results.filter((result) => result.status === 'stale').length, 1);
    assert.ok([first, second].includes(git(f.origin, ['rev-parse', 'main'])));
    assert.equal(git(f.origin, ['rev-list', '--count', 'main']), '2');
  },
);

test(
  'completed push remains confirmed after local HEAD and origin settings change',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const plan = await previewOriginPush(f.root, options);
    assert.equal((await executeOriginPush(plan, options)).status, 'pushed');
    await commit(f.root, 'later local work');
    const completed = await reconcileOriginPush(plan, options);
    assert.equal(completed.status, 'pushed');
    assert.equal(completed.remoteOid, plan.localOid);
    git(f.root, ['remote', 'set-url', 'origin', join(f.temporary, 'changed-origin')]);
    const historical = await reconcileOriginPush(plan, options);
    assert.equal(historical.status, 'pushed');
    assert.equal(historical.remoteOid, plan.localOid);
    assert.equal((await executeOriginPush(plan, options)).status, 'pushed');
    assert.equal(git(f.origin, ['rev-parse', 'main']), plan.localOid);
  },
);

test(
  'a synchronous authority revocation after async identity inspection prevents every Git spawn',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    let guards = 0;
    await assert.rejects(
      previewOriginPush(f.root, {
        ...options,
        assertCurrent() {
          guards += 1;
          throw new Error('ownership revoked');
        },
      }),
      /ownership revoked/,
    );
    assert.equal(guards, 1);
    assert.equal(git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), '');
  },
);

test(
  'an asynchronous push authority guard is rejected before dispatch and its rejection is observed',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      previewOriginPush(f.root, {
        ...options,
        assertCurrent() {
          return Promise.reject(new Error('late guard'));
        },
      }),
      /synchronous/,
    );
    assert.equal(git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), '');
  },
);

test(
  'a guard that aborts synchronously prevents the pending Git spawn',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t),
      controller = new AbortController();
    await assert.rejects(
      previewOriginPush(f.root, {
        ...options,
        signal: controller.signal,
        assertCurrent() {
          controller.abort();
        },
      }),
      /abort/i,
    );
    assert.equal(git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), '');
  },
);
