import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/evidence.js';

test('journal persists the inference limit through reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'randolph-journal-'));
  try {
    const journal = new Journal(dir);
    for (let index = 0; index < 8; index++) journal.reserveTurn();
    assert.throws(() => new Journal(dir).reserveTurn(), /Turn budget exhausted/);
    assert.equal(new Journal(dir).records.filter(event => event.type === 'turn.reserved').length, 8);
  } finally { rmSync(dir, { recursive: true }); }
});

test('partial trailing record requires explicit recovery; interior corruption is fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'randolph-journal-'));
  try {
    new Journal(dir).append('ready', 'Ready', {});
    appendFileSync(join(dir, 'events.jsonl'), '{"sequence":');
    assert.throws(() => new Journal(dir), /Incomplete trailing record/);
    assert.equal(new Journal(dir, true).records.length, 1);
    writeFileSync(join(dir, 'events.jsonl'), 'not-json\n');
    assert.throws(() => new Journal(dir, true), /Corrupt journal/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a bounded follow-up ceiling survives reopen and cannot be raised', () => {
  const dir = mkdtempSync(join(tmpdir(), 'randolph-budget-'));
  try {
    const journal = new Journal(dir);
    journal.limitTurns(3);
    for (let index = 0; index < 3; index++) journal.reserveTurn();
    const reopened = new Journal(dir);
    reopened.limitTurns(8);
    assert.throws(() => reopened.reserveTurn(), /Turn budget exhausted/);
  } finally { rmSync(dir, { recursive: true }); }
});
