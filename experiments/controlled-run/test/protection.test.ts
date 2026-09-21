import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFixture, observeFixture, removeFixture } from '../src/fixture.js';
import { permissionDiagnostic } from '../src/probe-script.js';
import { cleanEnvironment } from '../src/codex.js';

test('positive control proves diagnostic mutations succeed when not sandboxed', async () => {
  const base = join(homedir(), '.cache', 'randolph-positive-control');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  const fixture = await createFixture(join(root, 'fixture'), join(root, 'evidence'));
  try {
    const before = observeFixture(fixture);
    writeFileSync(join(fixture.worktree, 'permission-probe.mjs'), permissionDiagnostic(fixture));
    execFileSync(process.execPath, ['permission-probe.mjs'], {
      cwd: fixture.worktree,
      env: cleanEnvironment(process.env),
      timeout: 15_000,
      stdio: 'pipe',
    });
    const receipts = JSON.parse(
      readFileSync(join(fixture.worktree, 'permission-receipts.json'), 'utf8'),
    ) as { name: string; status: number }[];
    assert.deepEqual(
      receipts.map((item) => [item.name, item.status]),
      [
        ['commit', 0],
        ['ref', 0],
        ['push', 0],
        ['symlink', 0],
      ],
    );
    const after = observeFixture(fixture);
    assert.notEqual(before.workHead, after.workHead);
    assert.match(after.remoteRefs, /probe-push/);
    assert.ok(existsSync(join(fixture.repo, '.git', 'randolph-denial-canary')));
  } finally {
    await removeFixture(fixture);
    rmSync(root, { recursive: true });
  }
});
