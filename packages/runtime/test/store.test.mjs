import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../dist/index.js';

test('a future SQLite user_version is rejected without rewriting the database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'randolph-store-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'app.sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version=4');
  database.close();

  assert.throws(() => new Store(root), /newer Randolph version/);

  const reopened = new DatabaseSync(path, { readOnly: true });
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 4);
  reopened.close();
});
