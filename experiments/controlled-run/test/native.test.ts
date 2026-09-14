import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('default CLI invocation refuses native execution', () => {
  const result = spawnSync(process.execPath, ['dist/src/cli.js'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires explicit/);
  assert.equal(result.stdout, '');
});
