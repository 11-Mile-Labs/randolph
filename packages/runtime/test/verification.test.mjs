import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectVerificationCommands, runVerification } from '../src/verification.ts';

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'randolph-verification-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function nodeCheck(id, source, args = []) {
  return { id, label: id, command: process.execPath, args: ['-e', source, ...args] };
}

test('verification executes literal argv in the requested workspace and records success', async t => {
  const workspace = await fixture(t);
  const events = [];
  const payload = '$(touch injected); echo unsafe';
  const result = await runVerification(workspace, [nodeCheck('argv', 'console.log(process.cwd()); console.log(process.argv[1]);', [payload])], { executor: fixtureExecutor, onEvent: event => events.push(event) });
  assert.equal(result.status, 'passed');
  assert.equal(result.checks[0].exitCode, 0);
  assert.ok(result.checks[0].output.includes(payload));
  assert.ok(result.checks[0].output.includes(workspace));
  assert.equal(result.checks[0].cleanupVerified, true);
  assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(events.filter(event => event.type !== 'check-output').map(event => event.type), ['check-started', 'check-finished']);
});

// Test-only executor: production must provide the harness sandbox command API.
async function fixtureExecutor(workspace, command, { signal, onOutput }) {
  assert.equal(command.command, process.execPath);
  return new Promise(resolve => {
    const child = spawn(command.command, command.args, { cwd: workspace, shell: false, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(stop, 3000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      onOutput(text);
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve({ exitCode, output, truncated: false, cleanupVerified: child.pid ? !alive(child.pid) : true });
    });
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('failure stops subsequent checks and preserves stderr and exit status', async t => {
  const workspace = await fixture(t);
  const result = await runVerification(workspace, [nodeCheck('failure', 'console.error("broken"); process.exit(7);'), nodeCheck('later', 'console.log("not reached")')], { executor: fixtureExecutor });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].exitCode, 7);
  assert.match(result.checks[0].output, /broken/);
});

test('cancellation reaches the executor, confirms exit, and prevents later checks', async t => {
  const workspace = await fixture(t);
  const controller = new AbortController();
  let pid;
  const result = await runVerification(workspace, [nodeCheck('wait', 'console.log(process.pid); setInterval(() => {}, 1000);'), nodeCheck('later', 'console.log("not reached")')], {
    executor: fixtureExecutor,
    signal: controller.signal,
    onEvent: event => { if (event.type === 'check-output') { pid = Number(event.output.trim()); controller.abort(); } },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].cleanupVerified, true);
  assert.ok(pid > 0);
  assert.equal(alive(pid), false);
});

test('retained and streamed output are capped at 256 KiB and marked truncated', async t => {
  const workspace = await fixture(t);
  let emitted = 0;
  const result = await runVerification(workspace, [nodeCheck('large', 'process.stdout.write("é".repeat(200000)); process.stderr.write("x".repeat(200000));')], {
    executor: fixtureExecutor,
    onEvent: event => { if (event.output) emitted += Buffer.byteLength(event.output); },
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.checks[0].truncated, true);
  assert.ok(Buffer.byteLength(result.checks[0].output) <= 256 * 1024);
  assert.ok(emitted <= 256 * 1024);
});

test('cleanup uncertainty fails verification even when a command exits successfully', async t => {
  const workspace = await fixture(t);
  const result = await runVerification(workspace, [nodeCheck('uncertain', '')], { executor: async () => ({ exitCode: 0, output: '', truncated: false, cleanupVerified: false }) });
  assert.equal(result.status, 'failed');
  assert.match(result.checks[0].error, /cleanup/);
});

test('empty detection is unavailable and missing executor never launches a host command', async t => {
  const workspace = await fixture(t);
  assert.deepEqual(await detectVerificationCommands(workspace), []);
  assert.equal((await runVerification(workspace, [], {})).status, 'unavailable');
  const result = await runVerification(workspace, [nodeCheck('missing', 'process.exit(0)')], {});
  assert.equal(result.status, 'unavailable');
  assert.match(result.checks[0].error, /restricted verification executor/);
});

test('manifest detection covers declared pnpm scripts, Go checks and configured pytest only', async t => {
  const workspace = await fixture(t);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.8.0', scripts: { lint: 'anything; $(anything)', typecheck: 'tsc', build: 'tsc', test: 'node --test', deploy: 'ignored' } }));
  await writeFile(join(workspace, 'go.mod'), 'module example.invalid/fixture\n\ngo 1.24\n');
  await writeFile(join(workspace, 'pyproject.toml'), '[project]\nname = "fixture"\n');
  const detected = await detectVerificationCommands(workspace);
  assert.deepEqual(detected.map(({ command, args }) => [command, ...args]), [
    ['pnpm', 'run', 'lint'], ['pnpm', 'run', 'typecheck'], ['pnpm', 'run', 'build'], ['pnpm', 'run', 'test'],
    ['go', 'build', './...'], ['go', 'vet', './...'], ['go', 'test', './...'],
  ]);
  await writeFile(join(workspace, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  assert.deepEqual((await detectVerificationCommands(workspace)).at(-1).args, ['-m', 'pytest']);
});

test('unsupported package managers and malformed manifests cannot produce a false pass', async t => {
  const workspace = await fixture(t);
  for (const source of ['{', JSON.stringify({ packageManager: 'npm@10', scripts: { test: 'echo pass' } })]) {
    await writeFile(join(workspace, 'package.json'), source);
    const commands = await detectVerificationCommands(workspace);
    assert.equal(commands.length, 1);
    assert.ok(commands[0].unsupportedReason);
    const result = await runVerification(workspace, commands, { executor: async () => { assert.fail('unsupported check executed'); } });
    assert.equal(result.status, 'unavailable');
  }
});

test('pre-cancelled verification never calls the executor', async t => {
  const workspace = await fixture(t);
  const result = await runVerification(workspace, [nodeCheck('unused', '')], {
    signal: AbortSignal.abort(), executor: async () => { assert.fail('cancelled check executed'); },
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.checks, []);
});

test('executor failure reports cleanup uncertainty and requests cancellation', async t => {
  const workspace = await fixture(t);
  let executionSignal;
  const result = await runVerification(workspace, [nodeCheck('error', '')], {
    executor: async (_workspace, _command, { signal }) => { executionSignal = signal; throw new Error('transport closed'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0].cleanupVerified, false);
  assert.match(result.checks[0].error, /transport closed/);
  assert.equal(executionSignal.aborted, true);
});

test('inferred npm and yarn projects are unavailable without a pnpm declaration or lockfile', async t => {
  const workspace = await fixture(t);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(join(workspace, 'package-lock.json'), '{}');
  const detected = await detectVerificationCommands(workspace);
  assert.ok(detected[0].unsupportedReason);
});

test('an unresponsive executor returns cancellation with unconfirmed cleanup after a bounded wait', async t => {
  const workspace = await fixture(t);
  const controller = new AbortController();
  const result = await runVerification(workspace, [nodeCheck('unresponsive', '')], {
    signal: controller.signal,
    executor: async (_workspace, _command, { onOutput }) => {
      onOutput('started');
      return new Promise(() => {});
    },
    onEvent: event => { if (event.type === 'check-output') controller.abort(); },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.checks[0].cleanupVerified, false);
  assert.match(result.checks[0].error, /did not confirm cleanup/);
  assert.ok(result.elapsedMs >= 5000);
  assert.ok(result.elapsedMs < 10_000);
});


test('manifest boundary rejects external symbolic links instead of detecting their commands', async t => {
  const workspace = await fixture(t);
  const external = await fixture(t);
  const sources = {
    'package.json': JSON.stringify({ packageManager: 'pnpm@11', scripts: { test: 'external command' } }),
    'go.mod': 'module example.invalid/external\n',
    'pyproject.toml': '[tool.pytest.ini_options]\n',
  };
  for (const [name, source] of Object.entries(sources)) {
    await writeFile(join(external, name), source);
    await symlink(join(external, name), join(workspace, name));
  }
  const commands = await detectVerificationCommands(workspace);
  assert.equal(commands.length, 3);
  assert.ok(commands.every(command => command.unsupportedReason && command.command === ''));
});

test('manifest parse errors never include source snippets in review evidence', async t => {
  const workspace = await fixture(t);
  await writeFile(join(workspace, 'package.json'), 'PRIVATE_CANARY_JSON_SOURCE_NOT_FOR_EVIDENCE');
  const commands = await detectVerificationCommands(workspace);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].unsupportedReason, 'package.json is not valid JSON.');
  assert.ok(!JSON.stringify(commands).includes('PRIVATE'));
});

test('manifest boundary rejects a redirected workspace directory', async t => {
  const workspace = await fixture(t);
  const external = await fixture(t);
  await writeFile(join(external, 'package.json'), JSON.stringify({ scripts: { test: 'external command' } }));
  const redirected = join(workspace, 'redirected');
  await symlink(external, redirected, 'dir');
  const commands = await detectVerificationCommands(redirected);
  assert.ok(commands.length > 0);
  assert.ok(commands.every(command => command.unsupportedReason && !command.command));
});

test('manifest boundary rejects oversized input with bounded, source-free evidence', async t => {
  const workspace = await fixture(t);
  await writeFile(join(workspace, 'package.json'), 'PRIVATE_CANARY'.repeat(100000));
  const commands = await detectVerificationCommands(workspace);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].unsupportedReason, 'package.json exceeds the 1 MiB manifest limit.');
});
