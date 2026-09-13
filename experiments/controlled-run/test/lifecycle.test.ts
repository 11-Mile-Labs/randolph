import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../src/codex.js';
import { Journal } from '../src/evidence.js';
import { ProcessTracker, retainedRunState } from '../src/lifecycle.js';

const directory = mkdtempSync(join(tmpdir(), 'randolph-lifecycle-test-'));
after(() => rmSync(directory, { recursive: true, force: true }));

test('Stop closes effectful dispatch and declines late native approval without invoking the allow callback', async () => {
  const journal = new Journal(join(directory, 'stop'));
  let approvalCalled = false;
  const client = new CodexClient(journal, directory, 'codex', { home: directory, endpoint: 'http://127.0.0.1:1/v1', commandDecision: () => { approvalCalled = true; return 'accept'; } });
  const replies: unknown[] = [];
  client.send = value => { replies.push(value); };
  client.closeDispatch();
  client.closeDispatch();
  await assert.rejects(client.rpc('turn/start', {}), /Dispatch is closed/);
  await assert.rejects(client.rpc('thread/start', {}), /Dispatch is closed/);
  // Feed a native protocol callback without launching a harness or transport.
  Reflect.get(client, 'receive').call(client, JSON.stringify({ id: 8, method: 'item/commandExecution/requestApproval', params: { itemId: 'late', command: 'late command' } }));
  assert.equal(approvalCalled, false);
  assert.deepEqual(replies, [{ id: 8, result: { decision: 'decline' } }]);
  assert.equal(journal.records.filter(event => event.type === 'dispatch.closed').length, 1);
});

test('fresh process reopen maps unfinished execution to interrupted and adds no events', () => {
  const journal = new Journal(join(directory, 'reopen'));
  assert.equal(retainedRunState(journal), 'idle');
  journal.append('lifecycle.state', 'Started', { state: 'running' });
  const before = journal.records.length;
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../src/lifecycle-reopen.js', import.meta.url)), journal.directory], { encoding: 'utf8' });
  assert.equal(output.trim(), 'interrupted');
  assert.equal(new Journal(journal.directory).records.length, before);
  journal.append('lifecycle.state', 'Stopped', { state: 'stopped' });
  assert.equal(retainedRunState(new Journal(journal.directory)), 'stopped');
});

test('enumeration failure cannot certify an empty owned tree', () => {
  const journal = new Journal(join(directory, 'enumeration'));
  const binary = join(directory, 'failure.sh');
  writeFileSync(binary, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  const tracker = new ProcessTracker(binary, journal, { pid: 123, ppid: 1, pgid: 123, uid: 501, start: '1.000001', zombie: false });
  assert.throws(() => tracker.scan(), /enumeration failed/);
  assert.equal(tracker.uncertain, true);
});

test('omitted live retained identity is uncertain rather than exited', () => {
  const journal = new Journal(join(directory, 'omission'));
  const binary = join(directory, 'empty.sh');
  writeFileSync(binary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
  const tracker = new ProcessTracker(binary, journal, { pid: process.pid, ppid: process.ppid, pgid: process.pid, uid: process.getuid?.() ?? 501, start: '1.000001', zombie: false });
  assert.throws(() => tracker.scan(), /enumeration failed/);
  assert.equal(tracker.uncertain, true);
});

test('controller announces readiness before any supervisor or native dispatch', async () => {
  const controller = fork(fileURLToPath(new URL('../src/lifecycle-controller.js', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const [message] = await once(controller, 'message', { signal: AbortSignal.timeout(2_000) });
    assert.deepEqual(message, { type: 'controller-ready', pid: controller.pid });
    controller.disconnect();
    await once(controller, 'exit', { signal: AbortSignal.timeout(2_000) });
  } finally { if (controller.exitCode === null) controller.kill('SIGKILL'); }
});
