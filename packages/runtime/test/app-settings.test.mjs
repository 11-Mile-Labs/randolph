import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Runtime } from '../dist/index.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'randolph-app-settings-'));
  const runtime = new Runtime(
    {
      discover: async () => {
        throw new Error('Settings must not require a harness.');
      },
      run: async () => {
        throw new Error('Settings must not launch work.');
      },
    },
    root,
  );
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime };
}
test('app preferences and global lesson policy work without a project or native account', (t) => {
  const { root, runtime } = fixture(t),
    initial = runtime.appSettings();
  assert.equal(runtime.snapshot().projects.length, 0);
  assert.equal(initial.value.theme, 'system');
  assert.equal(initial.value.background, false);
  assert.equal(initial.globalMemory.value.autoApprove, false);
  const value = {
    theme: 'dark',
    background: true,
    notifications: { completed: true, failures: true, approvals: false },
  };
  const saved = runtime.saveAppSettings({ value, expectedRevision: initial.revision });
  assert.deepEqual(saved.value, value);
  assert.notEqual(saved.revision, initial.revision);
  const memory = runtime.saveGlobalMemory({
    autoApprove: true,
    expectedRevision: initial.globalMemory.revision,
  });
  assert.equal(memory.globalMemory.value.autoApprove, true);
  assert.equal(memory.revision, saved.revision);
  assert.match(readFileSync(join(root, 'config.app.yaml'), 'utf8'), /theme: dark/);
  assert.match(readFileSync(join(root, 'config.memory.yaml'), 'utf8'), /autoApprove: true/);
  assert.deepEqual(runtime.appSettings(), memory);
});
test('app preferences preserve external edits and reject malformed or stale writes', (t) => {
  const { root, runtime } = fixture(t);
  const first = runtime.saveAppSettings({
    value: runtime.appSettings().value,
    expectedRevision: null,
  });
  const path = join(root, 'config.app.yaml');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('theme: system', 'theme: light') + '# outside edit\n',
  );
  const changed = readFileSync(path, 'utf8');
  assert.throws(
    () =>
      runtime.saveAppSettings({
        value: { ...first.value, theme: 'dark' },
        expectedRevision: first.revision,
      }),
    /changed|reload/i,
  );
  assert.equal(readFileSync(path, 'utf8'), changed);
  writeFileSync(path, 'schemaVersion: 1\ntheme: [broken\n');
  assert.ok(runtime.appSettings().error);
  assert.throws(() => runtime.saveAppSettings({ value: first.value, expectedRevision: null }));
  assert.throws(
    () => runtime.saveGlobalMemory({ autoApprove: 'yes', expectedRevision: null }),
    /Invalid/,
  );
});
