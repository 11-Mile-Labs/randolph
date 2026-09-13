import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export type EventRecord = { sequence: number; time: string; runId: string; type: string;
  summary: string; details: Record<string, unknown> };

export class Journal {
  readonly records: EventRecord[] = [];
  readonly path: string;

  constructor(readonly directory: string, recover = false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'events.jsonl');
    let text = existsSync(this.path) ? readFileSync(this.path, 'utf8') : '';
    let recovered = false;
    if (text && !text.endsWith('\n')) {
      if (!recover) throw new Error('Incomplete trailing record: explicit recovery required');
      text = text.slice(0, text.lastIndexOf('\n') + 1);
      recovered = true;
    }
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line) as EventRecord;
        if (event.sequence !== this.records.length + 1 || typeof event.type !== 'string' ||
            typeof event.time !== 'string' || !event.details || typeof event.details !== 'object') throw new Error();
        if (event.type === 'budget.reserved' && (!Number.isFinite(event.details.milliseconds) || Number(event.details.milliseconds) <= 0)) {
          throw new Error();
        }
        if (event.type === 'turn.limit' && (!Number.isInteger(event.details.limit) || Number(event.details.limit) < 1 || Number(event.details.limit) > 8)) throw new Error();
        this.records.push(event);
      } catch { throw new Error('Corrupt journal: no automatic repair'); }
    }
    if (recovered) truncateSync(this.path, Buffer.byteLength(text));
  }

  append(type: string, summary: string, details: Record<string, unknown>): EventRecord {
    const event = { sequence: this.records.length + 1, time: new Date().toISOString(),
      runId: 'controlled-run', type, summary, details };
    const fd = openSync(this.path, 'a', 0o600);
    try {
      const bytes = Buffer.from(JSON.stringify(event) + '\n');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    }
    finally { closeSync(fd); }
    this.records.push(event);
    return event;
  }

  limitTurns(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Invalid turn limit');
    this.append('turn.limit', 'Explicit experiment turn ceiling', { limit });
  }

  reserveTurn(): void {
    const limit = Math.min(8, ...this.records.filter(event => event.type === 'turn.limit').map(event => Number(event.details.limit)));
    if (this.records.filter(event => event.type === 'turn.reserved').length >= limit) throw new Error('Turn budget exhausted');
    this.reserveTime(60_000);
    this.append('turn.reserved', 'One native turn reserved; limit 60 seconds', {});
  }

  reserveTime(milliseconds: number): void {
    const used = this.records.filter(event => event.type === 'budget.reserved')
      .reduce((sum, event) => sum + Number(event.details.milliseconds), 0);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || used + milliseconds > 900_000) {
      throw new Error('Active execution budget exhausted');
    }
    this.append('budget.reserved', 'Conservative active time reservation', { milliseconds });
  }
}
