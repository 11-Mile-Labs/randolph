import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient } from './codex.js';
import { Journal } from './evidence.js';
import { ProcessTracker } from './lifecycle.js';
import { sameIdentity, snapshot } from './process-identity.js';
import { validateEffectivePolicy } from './validation.js';
import type { ScriptedCall } from './scripted-server.js';
import { matchesCommand } from './scripted-git.js';

type Settings = {
  directory: string;
  home: string;
  endpoint: string;
  worktree: string;
  binary: string;
  call: ScriptedCall;
};
const send = (message: object): void => {
  if (process.connected) process.send?.(message);
};
let stopRequested = false;
let stop: ((reason: string) => Promise<void>) | undefined;
process.on('disconnect', () => {
  stopRequested = true;
  void stop?.('controller-lost');
});
process.on('message', (message: Settings & { type: string }) => {
  if (message.type === 'stop') {
    stopRequested = true;
    void stop?.('explicit-stop');
  }
  if (message.type === 'start')
    void run(message).catch((error) => {
      send({ type: 'error', reason: error instanceof Error ? error.message : 'Supervisor failed' });
      process.exitCode = 2;
      if (process.connected) process.disconnect();
    });
});

async function run(settings: Settings): Promise<void> {
  const journal = new Journal(settings.directory);
  mkdirSync(settings.home, { mode: 0o700 });
  const client = new CodexClient(journal, settings.worktree, 'codex', {
    home: settings.home,
    endpoint: settings.endpoint,
  });
  let tracker: ProcessTracker | undefined;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let threadId = '';
  let turnPromise: Promise<unknown> | undefined;
  let toolConfirmed = false;
  const controller = snapshot(settings.binary).find((item) => item.pid === process.ppid);
  if (!controller || stopRequested)
    throw new Error('Controller missing before supervisor readiness');
  journal.append('supervisor.ready', 'Independent supervisor ready before native dispatch', {
    controller,
    supervisorPid: process.pid,
  });
  stop = async (reason) => {
    if (stopping) return;
    stopping = true;
    stopRequested = true;
    const started = Date.now();
    client.closeDispatch();
    journal.append('lifecycle.state', 'Dispatch closed; stopping owned execution', {
      state: 'stopping',
      reason,
    });
    if (timer) clearInterval(timer);
    let remaining: unknown[] = [];
    let error: string | null = null;
    try {
      const turnId = client.notifications.findLast((event) => event.method === 'turn/started')
        ?.params?.turn?.id;
      if (
        turnId &&
        threadId &&
        client.process?.exitCode === null &&
        client.process?.signalCode === null
      ) {
        journal.append('native.interrupt', 'Request native cancellation before termination', {
          turnId,
        });
        await client.rpc('turn/interrupt', { threadId, turnId }, 1_500).catch(() => {});
      }
      await delay(Math.max(0, 2_000 - (Date.now() - started)));
      remaining = tracker ? await tracker.terminate(started + 5_000) : [];
    } catch {
      error = 'Ownership enumeration or termination uncertain';
    }
    const state =
      reason === 'explicit-stop' && !error && !remaining.length && !tracker?.uncertain
        ? 'stopped'
        : 'interrupted';
    const result = {
      state,
      reason,
      elapsedMs: Date.now() - started,
      remaining,
      uncertain: !!error || !!tracker?.uncertain,
      owned: [...(tracker?.owned.values() ?? [])],
      error,
    };
    journal.append(
      'lifecycle.state',
      'Termination observation retained; no restart dispatched',
      result,
    );
    writeFileSync(join(settings.directory, 'result.json'), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    send({ type: 'settled', ...result });
    // The observer rescues escapes only after recording the candidate verdict.
    await Promise.race([turnPromise ?? Promise.resolve(), delay(300)]);
    process.exit(error || remaining.length ? 2 : 0);
  };
  await client.start();
  const root = snapshot(settings.binary).find((item) => item.pid === client.process?.pid);
  if (!root) throw new Error('Native identity unavailable');
  tracker = new ProcessTracker(settings.binary, journal, root);
  journal.append('native.owned', 'Native ownership established before dispatch', { ...root });
  if (stopRequested || !process.connected) {
    await stop('controller-lost');
    return;
  }
  const thread = await client.startThread('mock-model');
  threadId = thread.thread.id;
  const policy = validateEffectivePolicy(thread, settings.worktree, 'codex-cli 0.149.0');
  if (!policy.matches || thread.modelProvider !== 'randolph_fixture') {
    await stop('invalid-policy');
    return;
  }
  journal.append('native.policy', 'Isolated native permissions verified', policy.evidence);
  if (stopRequested) {
    await stop('controller-lost');
    return;
  }
  journal.append('lifecycle.state', 'Explicit experiment dispatch', { state: 'running' });
  send({ type: 'native-ready', native: root, supervisorPid: process.pid });
  timer = setInterval(() => {
    if (stopping) return;
    try {
      const live = tracker!.scan();
      const item = client.notifications.find(
        (event) => event.method === 'item/started' && event.params?.item?.id === settings.call.id,
      )?.params?.item;
      if (
        !toolConfirmed &&
        item?.type === 'commandExecution' &&
        matchesCommand(item.command, settings.call.command) &&
        item.cwd === settings.worktree
      ) {
        toolConfirmed = true;
        journal.append('native.tool-confirmed', 'Exact native tool launch observed', {
          id: item.id,
          command: item.command,
          cwd: item.cwd,
        });
      }
      if (!live.some((item) => sameIdentity(item, root))) void stop!('harness-lost');
    } catch {
      void stop!('enumeration-failed');
    }
  }, 40);
  turnPromise = client
    .turn(threadId, 'mock-model', 'low', 'Run the prepared synthetic lifecycle fixture.')
    .catch((error) => {
      journal.append('native.turn-ended', 'Native turn ended during lifecycle probe', {
        reason: error instanceof Error ? error.message : 'Native error',
      });
    });
  // Hard bound independent of observer/controller liveness; not a passing lifecycle mechanism.
  setTimeout(() => {
    void stop?.('supervisor-deadline');
  }, 15_000).unref();
}
