import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  parseProjectContext,
  readProjectContext,
  writeProjectContext,
} from '../dist/project-context.js';

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'randolph-project-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('missing project context reads as empty and valid context preserves unrelated YAML and comments', (t) => {
  const root = fixture(t);
  const initial = readProjectContext(root);
  assert.deepEqual(initial, {
    revision: null,
    value: { purpose: '', instructions: '', documents: [] },
  });
  const saved = writeProjectContext(
    root,
    {
      purpose: 'Ship the app.',
      instructions: 'Keep changes small.',
      documents: [{ path: 'docs/plan.md', description: 'Release plan' }],
    },
    initial.revision,
  );
  assert.deepEqual(saved.value.documents, [{ path: 'docs/plan.md', description: 'Release plan' }]);
  const path = join(root, 'config.project.yaml');
  writeFileSync(
    path,
    `# Captain note\nschemaVersion: 1\nother: retained\npurpose: Ship the app.\ninstructions: Keep changes small.\ndocuments:\n  - path: docs/plan.md\n    description: Release plan\n`,
  );
  const reread = readProjectContext(root);
  const updated = writeProjectContext(
    root,
    { purpose: 'Updated purpose', instructions: '', documents: [] },
    reread.revision,
  );
  assert.deepEqual(updated.value, { purpose: 'Updated purpose', instructions: '', documents: [] });
  const output = readFileSync(path, 'utf8');
  assert.match(output, /# Captain note/);
  assert.match(output, /other: retained/);
  assert.match(output, /purpose: Updated purpose/);
});

test('stale saves and malformed files are rejected without mutating the file', (t) => {
  const root = fixture(t);
  const first = writeProjectContext(
    root,
    { purpose: 'One', instructions: 'Two', documents: [] },
    null,
  );
  const path = join(root, 'config.project.yaml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('purpose: One', 'purpose: External'));
  const changed = readFileSync(path, 'utf8');
  assert.throws(
    () =>
      writeProjectContext(
        root,
        { purpose: 'Three', instructions: 'Two', documents: [] },
        first.revision,
      ),
    /changed|reload/i,
  );
  assert.equal(readFileSync(path, 'utf8'), changed);
  writeFileSync(path, 'schemaVersion: 1\npurpose: [broken\n');
  assert.match(readProjectContext(root).error, /valid YAML/i);
  const malformed = readFileSync(path, 'utf8');
  assert.throws(() =>
    writeProjectContext(root, { purpose: 'Three', instructions: 'Two', documents: [] }, null),
  );
  assert.equal(readFileSync(path, 'utf8'), malformed);
});

test('save validation rejects unsafe, duplicate, unknown, and oversized values before writing', (t) => {
  const root = fixture(t);
  const cases = [
    [{ purpose: ' ', instructions: '', documents: [] }, /purpose.*empty/i],
    [
      { purpose: 'ok', instructions: '', documents: [{ path: '../secret', description: '' }] },
      /parent directory/i,
    ],
    [{ purpose: 'ok', instructions: '', documents: [{ path: 'a\\b', description: '' }] }, /POSIX/i],
    [
      {
        purpose: 'ok',
        instructions: '',
        documents: [
          { path: 'a', description: '' },
          { path: 'a', description: '' },
        ],
      },
      /duplicate/i,
    ],
    [
      { purpose: 'ok', instructions: '', documents: [{ path: 'a', description: '' }, 'bad'] },
      /entries.*objects/i,
    ],
  ];
  for (const [value, error] of cases)
    assert.throws(() => writeProjectContext(root, value, null), error);
  assert.equal(readProjectContext(root).revision, null);
});

test('pure validation and YAML roundtrip permit multiline text while retaining the declared bounds', (t) => {
  const root = fixture(t);
  const input = {
    purpose: 'Line one\nLine two\r\nIndented\ttext',
    instructions: 'First\n\tSecond',
    documents: [{ path: 'docs/plan.md', description: 'A\r\n\tuseful reference' }],
  };
  const context = parseProjectContext(input);
  assert.deepEqual(context, {
    purpose: 'Line one\nLine two\r\nIndented\ttext',
    instructions: 'First\n\tSecond',
    documents: [{ path: 'docs/plan.md', description: 'A\r\n\tuseful reference' }],
  });
  const saved = writeProjectContext(root, input, null);
  assert.deepEqual(readProjectContext(root).value, input);
  assert.ok(saved.revision);
  assert.throws(
    () => parseProjectContext({ purpose: `x${'a'.repeat(8000)}`, instructions: '', documents: [] }),
    /at most 8000/,
  );
  assert.throws(
    () =>
      parseProjectContext({ purpose: 'ok', instructions: `x${'a'.repeat(16000)}`, documents: [] }),
    /at most 16000/,
  );
  assert.throws(
    () =>
      parseProjectContext({
        purpose: 'ok',
        instructions: '',
        documents: [{ path: 'a', description: `x${'a'.repeat(2000)}` }],
      }),
    /at most 2000/,
  );
  assert.throws(
    () => parseProjectContext({ purpose: 'ok\0bad', instructions: '', documents: [] }),
    /control characters/,
  );
});

test('document references reject escaping, absolute, control, backslash, and duplicate paths', () => {
  const invalidPaths = ['../secret.md', '/absolute.md', 'docs\\plan.md', 'docs\nplan.md'];
  for (const path of invalidPaths) {
    assert.throws(
      () =>
        parseProjectContext({
          purpose: 'ok',
          instructions: '',
          documents: [{ path, description: '' }],
        }),
      /path/i,
    );
  }
  assert.throws(
    () =>
      parseProjectContext({
        purpose: 'ok',
        instructions: '',
        documents: [
          { path: 'docs/plan.md', description: '' },
          { path: 'docs//plan.md', description: '' },
        ],
      }),
    /duplicate/i,
  );
});
