import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeVersion } from './codex.js';
import { Journal } from './evidence.js';
import { EvidenceOwner } from './ownership.js';
import { createFixture, observeFixture, removeFixture, validateFixturePaths, type Fixture } from './fixture.js';
import { retainedRunState } from './lifecycle.js';
import { compileSnapshot, descendants, identityAlive, signalOwned, snapshot, type ProcessIdentity } from './process-identity.js';
import { ScriptedServer } from './scripted-server.js';

type Json = Record<string, any>;
const fixtureTool = String.raw`import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const [name, token, role] = process.argv.slice(2);
if (!/^[a-z-]+$/.test(name) || !/^[a-f0-9]+$/.test(token)) process.exit(2);
const directory = join(process.cwd(), name);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, role + '.json'), JSON.stringify({ pid: process.pid, token, role, started: Date.now() }));
if (role === 'root') {
  const detached = name === 'detached';
  const child = spawn(process.execPath, [process.argv[1], name, token, detached ? 'detached' : 'child'], { detached, stdio: 'ignore' });
  if (detached) { child.unref(); process.exit(0); }
}
process.on('SIGTERM', () => {});
const beat = () => appendFileSync(join(directory, role + '.heartbeat'), 'x');
beat();
setInterval(beat, 50);
setTimeout(() => writeFileSync(join(directory, role + '.canary'), token), 6000);
setTimeout(() => process.exit(0), 20000);
`;

async function until(predicate: () => boolean, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (predicate()) return; await delay(40); }
  throw new Error('Bounded lifecycle observation timed out');
}
const live = (binary: string, identity: ProcessIdentity): boolean => identityAlive(snapshot(binary, [identity.pid]), identity);

export async function runLifecycleProbe(dataDir: string, fixtureRoot: string): Promise<number> {
  validateFixturePaths(fixtureRoot, dataDir);
  const owner = EvidenceOwner.open(dataDir, false);
  const journal = new Journal(dataDir);
  const scratch = mkdtempSync(join(tmpdir(), 'randolph-lifecycle-'));
  let fixture: Fixture | undefined;
  let sentinel: ChildProcess | undefined;
  let controller: ChildProcess | undefined;
  let server: ScriptedServer | undefined;
  let binary = '';
  const rescue = new Map<number, ProcessIdentity>();
  const results: Json[] = [];
  let cleanupPassed = false;
  let failure: string | null = null;
  const started = Date.now();
  journal.append('experiment.authorization', 'Operator authorized bounded Stop and owner-loss native experiment', {
    cases: ['stop', 'controller-death', 'harness-death', 'detached'], inferenceCalls: 0,
    candidate: 'Per-run supervisor, controller IPC EOF, retained process-tree snapshots with native start identities',
    limitation: 'Polling can miss rapid reparenting; observer registration and rescue do not count as containment',
    deadlineMs: 5000, perCaseWatchdogMs: 15000 });
  try {
    const version = nativeVersion();
    if (version !== 'codex-cli 0.149.0') throw new Error('Requires inspected Codex version 0.149.0');
    binary = compileSnapshot(join(scratch, 'snapshot'));
    fixture = await createFixture(fixtureRoot, dataDir);
    const originalRefs = observeFixture(fixture);
    writeFileSync(join(fixture.worktree, 'lifecycle-tool.mjs'), fixtureTool);
    sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const sentinelIdentity = snapshot(binary).find(item => item.pid === sentinel?.pid);
    if (!sentinelIdentity) throw new Error('Unrelated sentinel identity unavailable');
    rescue.set(sentinelIdentity.pid, sentinelIdentity);
    for (const name of ['stop', 'controller-death', 'harness-death', 'detached']) {
      const directory = join(dataDir, name);
      mkdirSync(directory, { mode: 0o700 });
      const supervisorDir = join(directory, 'supervisor');
      const caseJournal = new Journal(directory);
      server = new ScriptedServer(caseJournal);
      await server.start();
      const token = randomUUID().replaceAll('-', '');
      const command = `node lifecycle-tool.mjs ${name} ${token} root`;
      const call = { id: `lifecycle-${name}`, command, cwd: fixture.worktree, escalated: false, timeoutMs: 60_000 };
      server.prepare(call);
      const messages: Json[] = [];
      controller = fork(fileURLToPath(new URL('./lifecycle-controller.js', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      controller.stderr?.on('data', () => {});
      controller.on('message', message => messages.push(message as Json));
      const controllerIdentity = snapshot(binary).find(item => item.pid === controller?.pid);
      if (!controllerIdentity) throw new Error('Controller identity unavailable');
      rescue.set(controllerIdentity.pid, controllerIdentity);
      controller.send({ type: 'start', directory: supervisorDir, home: join(fixture.root, `home-${name}`),
        worktree: fixture.worktree, binary, endpoint: server.endpoint, call });
      await until(() => !!messages.find(message => message.type === 'native-ready'), 7_000);
      const ready = messages.find(message => message.type === 'native-ready')!;
      const native = ready.native as ProcessIdentity;
      rescue.set(native.pid, native);
      const supervisorIdentity = snapshot(binary).find(item => item.pid === ready.supervisorPid);
      if (!supervisorIdentity) throw new Error('Supervisor identity unavailable');
      rescue.set(supervisorIdentity.pid, supervisorIdentity);
      const roles = name === 'detached' ? ['detached'] : ['root', 'child'];
      const actors: ProcessIdentity[] = [];
      const fixtureDirectory = join(fixture.worktree, name);
      await until(() => roles.every(role => existsSync(join(fixtureDirectory, `${role}.heartbeat`))) &&
        new Journal(supervisorDir).records.some(event => event.type === 'native.tool-confirmed'), 5_000);
      for (const role of roles) {
        const receipt = JSON.parse(readFileSync(join(fixtureDirectory, `${role}.json`), 'utf8'));
        if (receipt.token !== token || receipt.role !== role) throw new Error('Fixture receipt mismatch');
        const identity = snapshot(binary).find(item => item.pid === receipt.pid && !item.zombie);
        if (!identity) throw new Error('Fixture actor not alive before fault');
        const argv = execFileSync('/bin/ps', ['-p', String(identity.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
        if (!argv.endsWith(`lifecycle-tool.mjs ${name} ${token} ${role}`)) throw new Error('Fixture actor command identity mismatch');
        if (!live(binary, identity)) throw new Error('Fixture actor identity changed');
        actors.push(identity);
        rescue.set(identity.pid, identity);
      }
      // Independent observation sees known synthetic actors; the candidate never reads their receipt files.
      caseJournal.append('fixture.active', 'Native-launched fixture actors alive before fault', { actors, native, controller: controllerIdentity, supervisor: supervisorIdentity });
      const faultTime = Date.now();
      if (name === 'controller-death') signalOwned(controllerIdentity, 'SIGKILL', binary);
      else if (name === 'harness-death') signalOwned(native, 'SIGKILL', binary);
      else controller.send({ type: 'stop' });
      caseJournal.append('fault.injected', 'Named fault injected without group termination', { name, faultTime });
      await until(() => existsSync(join(supervisorDir, 'result.json')), 7_000);
      const faultToResultMs = Date.now() - faultTime;
      const candidate = JSON.parse(readFileSync(join(supervisorDir, 'result.json'), 'utf8'));
      const remaining = actors.filter(identity => live(binary, identity));
      const heartbeatSizes = roles.map(role => readFileSync(join(fixtureDirectory, `${role}.heartbeat`)).length);
      await delay(Math.max(0, 6_500 - (Date.now() - faultTime)));
      const stable = roles.every((role, index) => readFileSync(join(fixtureDirectory, `${role}.heartbeat`)).length === heartbeatSizes[index]);
      const lateCanary = roles.some(role => existsSync(join(fixtureDirectory, `${role}.canary`)));
      const reopened = new Journal(supervisorDir);
      const state = retainedRunState(reopened);
      const countBefore = reopened.records.filter(event => event.type === 'scripted.turn').length;
      const reopenStart = Date.now();
      // A new process performs the read-only reopen; it must not create a native session.
      const reopen = execFileSync(process.execPath, [fileURLToPath(new URL('./lifecycle-reopen.js', import.meta.url)), supervisorDir], { encoding: 'utf8', timeout: 2_000 }).trim();
      const countAfter = new Journal(supervisorDir).records.filter(event => event.type === 'scripted.turn').length;
      const refsUnchanged = JSON.stringify(observeFixture(fixture)) === JSON.stringify(originalRefs);
      const supervisorLog = new Journal(supervisorDir);
      const dispatch = supervisorLog.records.find(event => event.type === 'dispatch.closed');
      const expectedState = name === 'controller-death' || name === 'harness-death' ? 'interrupted' : 'stopped';
      const passed = !candidate.uncertain && !remaining.length && candidate.elapsedMs <= 5_000 && faultToResultMs <= 5_000 && stable && !lateCanary &&
        state === expectedState && reopen === expectedState && countBefore === 1 && countAfter === 1 &&
        !!dispatch && refsUnchanged && live(binary, sentinelIdentity) && !live(binary, native) && !live(binary, supervisorIdentity) &&
        server.errors.length === 0 && server.requests.length >= 1 && !supervisorLog.records.some(event => event.type === 'turn.reserved');
      const result = { name, verdict: passed ? 'passed' : candidate.uncertain ? 'unverified' : 'failed', candidate, faultToResultMs,
        remainingBeforeRescue: remaining, stableAfterTermination: stable, lateCanary, retainedState: state, reopenedState: reopen,
        reopenMs: Date.now() - reopenStart, scriptedTurnsBeforeReopen: countBefore, scriptedTurnsAfterReopen: countAfter,
        refsUnchanged, unrelatedSentinelAlive: live(binary, sentinelIdentity), nativeExited: !live(binary, native),
        dispatchClosed: !!dispatch, dispatchClosedMs: dispatch ? Date.parse(dispatch.time) - faultTime : null,
        localResponses: server.requests.length, modelCalls: 0 };
      results.push(result);
      caseJournal.append('case.verdict', 'Candidate verdict recorded before independent watchdog rescue', result);
      process.stdout.write(`${name}: ${result.verdict}; shutdown ${candidate.elapsedMs}ms; escaped actors ${remaining.length}\n`);
      for (const identity of remaining) signalOwned(identity, 'SIGKILL', binary);
      caseJournal.append('watchdog.rescue', 'Test-only rescue cannot turn failure into pass', { rescued: remaining });
      await until(() => actors.every(identity => !live(binary, identity)), 2_000);
      await server.close();
      server = undefined;
      if (controller.connected) controller.disconnect();
      controller = undefined;
      // A failed boundary ends the experiment rather than expanding into a daemon or VM.
      if (!passed) break;
    }
  } catch (error) {
    failure = error instanceof Error && !('stdout' in error) ? error.message : 'Lifecycle probe failed; raw subprocess output omitted';
    journal.append('probe.error', 'Bounded lifecycle probe stopped', { reason: failure });
  } finally {
    if (controller?.connected) controller.disconnect();
    if (binary) {
      let enumerationCertain = true;
      try {
        const current = snapshot(binary);
        for (const identity of descendants(current, [...rescue.values()])) rescue.set(identity.pid, identity);
      } catch { enumerationCertain = false; }
      for (const identity of [...rescue.values()].reverse()) {
        try { signalOwned(identity, 'SIGKILL', binary); } catch { enumerationCertain = false; }
      }
      await delay(200);
      try { cleanupPassed = [...rescue.values()].every(identity => !live(binary, identity)) && enumerationCertain; }
      catch { cleanupPassed = false; }
    }
    await server?.close();
    if (fixture && cleanupPassed) await removeFixture(fixture);
    if (cleanupPassed) rmSync(scratch, { recursive: true, force: true });
    journal.append('cleanup', 'Observed process cleanup and fixture retention', { cleanupPassed, fixtureRemoved: !!fixture && cleanupPassed });
    const verdict = results.some(result => result.verdict === 'failed') ? 'failed' : !failure && cleanupPassed && results.length === 4 && results.every(result => result.verdict === 'passed') ? 'passed' : 'unverified';
    writeFileSync(join(dataDir, 'results.json'), JSON.stringify({ verdict, results, failure, cleanupPassed, elapsedMs: Date.now() - started, inferenceCalls: 0 }, null, 2), { mode: 0o600 });
    owner.seal();
  }
  return !failure && cleanupPassed && results.length === 4 && results.every(result => result.verdict === 'passed') ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'data-dir': { type: 'string' }, 'fixture-root': { type: 'string' } } });
    if (!values.run || !values['data-dir'] || !values['fixture-root']) throw new Error('Explicit --run and absolute directories required');
    process.exitCode = await runLifecycleProbe(values['data-dir'], values['fixture-root']);
  } catch { process.stderr.write('Lifecycle probe refused or failed.\n'); process.exitCode = 1; }
}
