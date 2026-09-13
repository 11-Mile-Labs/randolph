import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceOwner } from '../src/ownership.js';
test('evidence ownership rejects existing directories and permits only a sealed unchanged correction', () => {
  const parent = mkdtempSync(join(tmpdir(), 'randolph-owner-'));
  try {
    assert.throws(() => EvidenceOwner.open(parent, false), /EEXIST/);
    const dir = join(parent, 'run');
    const owner = EvidenceOwner.open(dir, false);
    writeFileSync(join(dir, 'events.jsonl'), 'evidence\n');
    assert.throws(() => EvidenceOwner.open(dir, true), /ownership/);
    owner.seal();
    EvidenceOwner.open(dir, true);
    writeFileSync(join(dir, 'events.jsonl'), 'tampered\n');
    assert.throws(() => EvidenceOwner.open(dir, true), /ownership/);
  } finally { rmSync(parent, { recursive: true }); }
});
test('correction rejects symlink and regular-file replacement without touching their targets', () => {
  const parent = mkdtempSync(join(tmpdir(), 'randolph-owner-'));
  try {
    const dir = join(parent, 'run');
    const owner = EvidenceOwner.open(dir, false);
    const path = join(dir, 'results.json');
    writeFileSync(path, 'original');
    owner.seal();
    renameSync(path, join(parent, 'original'));
    writeFileSync(path, 'original');
    assert.throws(() => EvidenceOwner.open(dir, true), /ownership/);
    rmSync(path);
    symlinkSync(join(parent, 'original'), path);
    assert.throws(() => EvidenceOwner.open(dir, true), /regular/);
    assert.equal(readFileSync(join(parent, 'original'), 'utf8'), 'original');
  } finally { rmSync(parent, { recursive: true }); }
});
