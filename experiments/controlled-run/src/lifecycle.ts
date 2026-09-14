import type { Journal } from './evidence.js';
import {
  descendants,
  identityAlive,
  sameIdentity,
  signalOwned,
  snapshot,
  type ProcessIdentity,
} from './process-identity.js';
import { setTimeout as delay } from 'node:timers/promises';

export function retainedRunState(journal: Journal): 'idle' | 'stopped' | 'interrupted' {
  const last = journal.records.findLast((event) => event.type === 'lifecycle.state');
  return last?.details.state === 'stopped' ? 'stopped' : last ? 'interrupted' : 'idle';
}

/** Polling observes descendants; it cannot contain a process that reparents between snapshots. */
export class ProcessTracker {
  readonly owned = new Map<number, ProcessIdentity>();
  uncertain = false;
  constructor(
    readonly binary: string,
    readonly journal: Journal,
    root: ProcessIdentity,
  ) {
    this.owned.set(root.pid, root);
  }

  scan(): ProcessIdentity[] {
    try {
      const current = snapshot(this.binary);
      for (const identity of this.owned.values()) identityAlive(current, identity);
      for (const child of descendants(current, [...this.owned.values()])) {
        if (!this.owned.has(child.pid)) {
          this.owned.set(child.pid, child);
          this.journal.append('process.observed', 'Owned descendant observed', { ...child });
        }
      }
      return current.filter((item) => !item.zombie && sameIdentity(item, this.owned.get(item.pid)));
    } catch {
      this.uncertain = true;
      this.journal.append(
        'process.uncertain',
        'Process enumeration failed; exit cannot be certified',
        {},
      );
      throw new Error('Process enumeration failed');
    }
  }

  async terminate(deadline: number): Promise<ProcessIdentity[]> {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const identity of this.scan().reverse()) {
        const outcome = signalOwned(identity, signal, this.binary);
        this.journal.append('process.signal', 'Identity-checked termination', {
          ...identity,
          signal,
          outcome,
        });
        if (outcome === 'identity-changed') this.uncertain = true;
      }
      await delay(100);
    }
    while (Date.now() < deadline) {
      const live = this.scan();
      if (!live.length) return [];
      await delay(40);
    }
    return this.scan();
  }
}
