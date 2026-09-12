import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readHarnessSettings, writeHarnessSettings } from '../dist/harness-settings.js';

const defaults = { harness: 'codex', model: 'native-model', effort: 'low' };
const content = '# Project defaults\nschemaVersion: 1\nharness: codex\nmodel: native-model # retain this comment\neffort: low\ncustom: keep-me\n';
async function fixture(t) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'randolph-settings-')));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, path: join(root, 'config.harness.yaml') };
}

test('missing settings are read without creating a file, while missing projects report errors', async t => {
  const { root, path } = await fixture(t);
  assert.deepEqual(readHarnessSettings(root), { revision: null, defaults: null });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.match(readHarnessSettings(join(root, 'absent')).error, /project|directory/i);
});

test('read returns native defaults with an exact raw-byte revision and does not rewrite YAML', async t => {
  const { root, path } = await fixture(t);
  await writeFile(path, content);
  assert.deepEqual(readHarnessSettings(root), {
    revision: createHash('sha256').update(content).digest('hex'), defaults,
  });
  assert.equal(await readFile(path, 'utf8'), content);
});

test('save creates versioned settings, preserves comments and unrelated YAML, and returns a new revision', async t => {
  const { root, path } = await fixture(t);
  const first = writeHarnessSettings(root, defaults, null);
  assert.deepEqual(first.defaults, defaults);
  assert.equal(readHarnessSettings(root).revision, first.revision);
  assert.match(await readFile(path, 'utf8'), /schemaVersion: 1/);
  await writeFile(path, content);
  const before = readHarnessSettings(root);
  const saved = writeHarnessSettings(root, { ...defaults, effort: 'high' }, before.revision);
  assert.equal(saved.defaults.effort, 'high');
  assert.notEqual(saved.revision, before.revision);
  const text = await readFile(path, 'utf8');
  assert.match(text, /# Project defaults/);
  assert.match(text, /# retain this comment/);
  assert.match(text, /custom: keep-me/);
});

test('an external edit causes a stale revision error without overwriting it', async t => {
  const { root, path } = await fixture(t);
  const initial = writeHarnessSettings(root, defaults, null);
  await writeFile(path, content);
  assert.throws(() => writeHarnessSettings(root, defaults, initial.revision), /changed|stale/i);
  assert.equal(await readFile(path, 'utf8'), content);
  assert.throws(() => writeHarnessSettings(root, defaults, null), /changed|stale/i);
});

test('malformed or unsupported YAML is visible and cannot be overwritten by Save', async t => {
  const { root, path } = await fixture(t);
  for (const source of [
    'bad: [', '[]', 'schemaVersion: 2\nharness: codex\nmodel: x\neffort: low\n',
    'schemaVersion: 1\nharness: claude\nmodel: x\neffort: low\n',
    'schemaVersion: 1\nharness: codex\nmodel: x\nmodel: y\neffort: low\n',
    'schemaVersion: 1\nharness: codex\nmodel: ""\neffort: low\n',
    'schemaVersion: 1\nharness: codex\nmodel: x\neffort: 1\n',
    'schemaVersion: 1\nharness: codex\nmodel: &value x\neffort: *value\n',
  ]) {
    await writeFile(path, source);
    const current = readHarnessSettings(root);
    assert.equal(current.defaults, null);
    assert.ok(current.error, source);
    assert.throws(() => writeHarnessSettings(root, defaults, current.revision));
    assert.equal(await readFile(path, 'utf8'), source);
  }
});

test('oversized files and invalid save inputs are rejected without writes', async t => {
  const { root, path } = await fixture(t);
  const oversized = `${content}#${'x'.repeat(65_536)}`;
  await writeFile(path, oversized);
  assert.match(readHarnessSettings(root).error, /64|large|size/i);
  assert.throws(() => writeHarnessSettings(root, defaults, null));
  assert.equal(await readFile(path, 'utf8'), oversized);
  await rm(path);
  for (const invalid of [{ ...defaults, model: '' }, { ...defaults, effort: 'x\ny' }, { ...defaults, harness: 'claude' }]) {
    assert.throws(() => writeHarnessSettings(root, invalid, null));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
});

test('symlinked or hardlinked settings and directories are rejected without changing targets', async t => {
  const { root, path } = await fixture(t);
  const target = join(root, 'target.yaml');
  await writeFile(target, content);
  await symlink(target, path);
  assert.match(readHarnessSettings(root).error, /link|regular/i);
  assert.throws(() => writeHarnessSettings(root, defaults, null));
  assert.equal(await readFile(target, 'utf8'), content);
  await rm(path);
  await link(target, path);
  assert.match(readHarnessSettings(root).error, /link|regular/i);
  assert.throws(() => writeHarnessSettings(root, defaults, null));
  await rm(path);
  await mkdir(path);
  assert.match(readHarnessSettings(root).error, /regular|file/i);
  assert.throws(() => writeHarnessSettings(root, defaults, null));
});

test('redirecting a saved project root through a symlink cannot read or write another project', async t => {
  const { root } = await fixture(t);
  const target = join(root, 'actual');
  const redirected = join(root, 'redirected');
  await mkdir(target);
  await writeFile(join(target, 'config.harness.yaml'), content);
  await symlink(target, redirected);
  assert.match(readHarnessSettings(redirected).error, /project|link|redirect/i);
  assert.throws(() => writeHarnessSettings(redirected, defaults, null));
  assert.equal(await readFile(join(target, 'config.harness.yaml'), 'utf8'), content);
});


test('project CLI selection survives persistence and rejects non-absolute executable paths', async t => {
  const { root } = await fixture(t);
  const configured = { ...defaults, executable: '/opt/example/bin/codex' };
  const saved = writeHarnessSettings(root, configured, null);
  assert.deepEqual(readHarnessSettings(root).defaults, configured);
  assert.throws(() => writeHarnessSettings(root, { ...defaults, executable: 'relative/codex' }, saved.revision), /executable|absolute/i);
  assert.deepEqual(readHarnessSettings(root).defaults, configured);
});

test('Grok defaults round-trip as a complete harness selection', async t => {
  const { root } = await fixture(t);
  const grok = { harness: 'grok', model: 'grok-1.0.25', effort: 'low', executable: '/opt/grok/bin/grok' };
  const saved = writeHarnessSettings(root, grok, null);
  assert.deepEqual(readHarnessSettings(root), { revision: saved.revision, defaults: grok });
});

test('explicit enabled CLI routes persist separately and survive legacy defaults saves', async t => {
  const { root, path } = await fixture(t);
  const routes = [{ harness: 'codex', executable: '/opt/codex' }, { harness: 'grok', executable: '/opt/grok' }];
  const first = writeHarnessSettings(root, defaults, null, routes);
  assert.deepEqual(first.enabledRoutes, routes);
  assert.deepEqual(readHarnessSettings(root).enabledRoutes, routes);
  const next = writeHarnessSettings(root, { ...defaults, effort: 'high' }, first.revision);
  assert.deepEqual(next.enabledRoutes, routes);
  const disabled = writeHarnessSettings(root, defaults, next.revision, []);
  assert.deepEqual(readHarnessSettings(root).enabledRoutes, []);
  assert.match(await readFile(path, 'utf8'), /enabledRoutes: \[\]/);
  assert.notEqual(disabled.revision, next.revision);
});

test('enabled routes reject duplicate, relative, malformed and unbounded routes before saving', async t => {
  const { root, path } = await fixture(t);
  const route = { harness: 'codex', executable: '/opt/codex' };
  for (const routes of [null, {}, [route, route], [{ ...route, executable: 'codex' }], [{ ...route, harness: 'other' }], [{ ...route, executable: '/x\ny' }], Array.from({length: 33}, (_, i) => ({ ...route, executable: `/opt/${i}` }))]) {
    assert.throws(() => writeHarnessSettings(root, defaults, null, routes));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  await writeFile(path, `${content}enabledRoutes: [{harness: codex, executable: relative}]\n`);
  assert.ok(readHarnessSettings(root).error);
});
