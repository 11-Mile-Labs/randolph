import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../dist/index.js';

test('a future SQLite user_version is rejected without rewriting the database', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'randolph-store-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'app.sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version=6');
  database.close();

  assert.throws(() => new Store(root), /newer Randolph version/);

  const reopened = new DatabaseSync(path, { readOnly: true });
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 6);
  reopened.close();
});

test('a nested transaction rolls back to its savepoint without aborting the outer transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'randolph-store-test-'));
  const store = new Store(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.db.exec('CREATE TABLE savepoint_probe(id TEXT PRIMARY KEY)');
  store.transaction(() => {
    store.db.prepare('INSERT INTO savepoint_probe(id) VALUES (?)').run('one');
    assert.throws(
      () =>
        store.transaction(() => {
          store.db.prepare('INSERT INTO savepoint_probe(id) VALUES (?)').run('two');
          throw new Error('Injected nested failure');
        }),
      /Injected nested failure/,
    );
    store.db.prepare('INSERT INTO savepoint_probe(id) VALUES (?)').run('three');
  });
  assert.deepEqual(
    store.db
      .prepare('SELECT id FROM savepoint_probe ORDER BY id')
      .all()
      .map((row) => row.id),
    ['one', 'three'],
  );
});
