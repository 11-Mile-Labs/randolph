import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { CodexAdapter } from '../dist/index.js';

function fakeChild({ accountType = 'chatgpt', modelId = 'gpt-test', delayInitialize = 0, turnStatus = 'completed', invalid = false, threadResponse, notifications = [], commandResult = { exitCode: 0, stdout: '', stderr: '' }, commandOutput = 'checks passed\n', commandDelay = 0, beforeResponse = () => {} } = {}) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.methods = [];
  child.requests = [];
  child.replies = [];
  let threadId = '';
  const send = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...rest) => {
    const request = JSON.parse(String(chunk));
    if (!request.method) { child.replies.push(request); return originalWrite(chunk, ...rest); }
    child.methods.push(request.method);
    child.requests.push(request);
    const respond = () => {
      beforeResponse(request.method);
      if (invalid) { child.stdout.write('{not-json}\n'); return; }
      if (request.method === 'account/read') send({ id: request.id, result: { account: { type: accountType } } });
      else if (request.method === 'model/list') send({ id: request.id, result: { data: [{ model: modelId, displayName: 'Test Model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] } });
      else if (request.method === 'command/exec') {
        send({ method: 'command/exec/outputDelta', params: { processId: request.params.processId, stream: 'stdout', deltaBase64: Buffer.from(commandOutput).toString('base64'), capReached: false } });
        setTimeout(() => { send({ id: request.id, result: commandResult }); }, commandDelay);
      }
      else if (request.method === 'thread/start') { threadId = 'thread-' + Math.random().toString(16).slice(2); send({ id: request.id, result: { thread: { id: threadId }, ...threadResponse } }); }
      else if (request.method === 'turn/start') {
        send({ id: request.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'item/commandExecution/delta', params: { itemId: 'command-1', delta: 'secret command' } });
        for (const notification of notifications) send(notification);
        send({ method: 'item/agentMessage/delta', params: { itemId: 'message-1', delta: modelId } });
        send({ method: 'turn/completed', params: { turn: { status: turnStatus } } });
      } else if (request.method === 'turn/interrupt') send({ id: request.id, result: {} });
      else send({ id: request.id, result: {} });
    };
    setTimeout(respond, request.method === 'initialize' ? delayInitialize : 0);
    return originalWrite(chunk, ...rest);
  };
  child.kill = () => { child.exitCode = 0; child.signalCode = 'SIGTERM'; child.emit('close'); return true; };
  return child;
}

function adapterFor(children, extra = {}) {
  return new CodexAdapter({ executable: 'fake-codex', execFile: () => 'codex-cli 0.149.0', spawn: (_file, args, options) => {
    const child = children.shift();
    assert.ok(child, 'unexpected native process launch');
    child.launch = { args, options };
    return child;
  }, ...extra });
}

const runInput = (signal, events = [], model = 'gpt-test') => ({ workspace: realpathSync(process.cwd()), model, effort: 'low', messages: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'prior answer' }], signal, onEvent: (event) => events.push(event) });

test('discover uses native account and model RPCs and rejects API-key accounts', async () => {
  const child = fakeChild({ accountType: 'apiKey' });
  const calls = [];
  const adapter = adapterFor([child], { execFile: (_file, args) => { calls.push(args); return 'codex-cli 0.149.0'; } });
  const info = await adapter.discover();
  assert.equal(info.available, true);
  assert.equal(info.authenticated, false);
  assert.match(info.reason, /ChatGPT/);
  assert.deepEqual(calls, [['--version']]);
  assert.ok(child.launch.args.includes('model_provider="openai"'));
});

test('discover returns native model efforts for ChatGPT account', async () => {
  const child = fakeChild({ modelId: 'gpt-test' });
  const adapter = adapterFor([child], { execFile: () => 'codex-cli 0.149.0' });
  const info = await adapter.discover();
  assert.equal(info.authenticated, true);
  assert.deepEqual(info.models, [{ id: 'gpt-test', name: 'Test Model', efforts: ['low'], defaultEffort: 'low' }]);
});

test('run emits only agent-message deltas and keeps each concurrent client isolated', async () => {
  const first = fakeChild({ modelId: 'first' });
  const second = fakeChild({ modelId: 'second' });
  const adapter = adapterFor([first, second]);
  const eventsA = [], eventsB = [];
  const [a, b] = await Promise.all([adapter.run(runInput(new AbortController().signal, eventsA, 'first')), adapter.run(runInput(new AbortController().signal, eventsB, 'second'))]);
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'completed');
  assert.deepEqual(eventsA.filter((event) => event.type === 'message.delta').map((event) => event.data), [{ messageId: 'message-1', text: 'first' }]);
  assert.deepEqual(eventsB.filter((event) => event.type === 'message.delta').map((event) => event.data), [{ messageId: 'message-1', text: 'second' }]);
  assert.ok(eventsA.every((event) => !JSON.stringify(event).includes('secret command')));
  assert.match(first.launch.args.join(' '), /sandbox_mode="read-only"/);
  assert.match(first.launch.args.join(' '), /approval_policy="never"/);
});

test('failed turns and malformed transport fail the run', async () => {
  await assert.rejects(adapterFor([fakeChild({ turnStatus: 'failed' })]).run(runInput(new AbortController().signal)), /turn failed/);
  await assert.rejects(adapterFor([fakeChild({ invalid: true })]).run(runInput(new AbortController().signal)), /invalid JSON|Expected property/);
});

test('abort before startup does not spawn a child', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const adapter = new CodexAdapter({ executable: 'fake-codex', spawn: () => { spawned = true; throw new Error('must not spawn'); } });
  const result = await adapter.run(runInput(controller.signal));
  assert.equal(result.status, 'interrupted');
  assert.equal(spawned, false);
});

test('abort during startup sends no late turn start', async () => {
  const child = fakeChild({ delayInitialize: 100 });
  const adapter = adapterFor([child]);
  const controller = new AbortController();
  const run = adapter.run(runInput(controller.signal));
  setTimeout(() => controller.abort(), 10);
  const result = await run;
  assert.ok(['interrupted', 'stop-unconfirmed'].includes(result.status));
  assert.equal(child.methods.includes('turn/start'), false);
});

function codeFixture(t, policyOverrides = {}) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'randolph-codex-code-')));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); });
  const policy = { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true, ...policyOverrides };
  return { workspace, policy, threadResponse: { cwd: workspace, approvalPolicy: 'never', sandbox: policy } };
}

test('read-only execution rejects redirected workspaces before native launch', async t => {
  const { workspace } = codeFixture(t);
  const link = join(workspace, 'redirected');
  symlinkSync(workspace, link);
  const child = fakeChild();
  await assert.rejects(adapterFor([child]).run({ ...runInput(new AbortController().signal), workspace: link }), /canonical|workspace/);
  assert.equal(child.launch, undefined);
});

for (const boundary of ['account/read', 'thread/start']) {
  test(`read-only execution rejects directory replacement during ${boundary}`, async t => {
    const { workspace } = codeFixture(t);
    const project = join(workspace, 'project');
    mkdirSync(project);
    const child = fakeChild({ beforeResponse(method) {
      if (method === boundary) { renameSync(project, join(workspace, 'original')); mkdirSync(project); }
    } });
    await assert.rejects(adapterFor([child]).run({ ...runInput(new AbortController().signal), workspace: project }), /workspace.*changed/);
    assert.equal(child.methods.includes('turn/start'), false);
    assert.equal(child.exitCode, 0);
  });
}

test('code capability is advertised only for authenticated verified native version', async () => {
  for (const [version, accountType, expected] of [
    ['codex-cli 0.149.0', 'chatgpt', ['read-only', 'code']],
    ['codex-cli 0.154.0', 'chatgpt', ['read-only', 'code']],
    ['codex-cli 0.154.0-alpha.6.2', 'chatgpt', ['read-only']],
    ['codex-cli 0.150.0', 'chatgpt', ['read-only']],
    ['codex-cli 0.149.0-dev', 'chatgpt', ['read-only']],
    ['codex-cli 0.149.0', 'apiKey', []],
  ]) {
    const info = await adapterFor([fakeChild({ accountType })], { execFile: () => version }).discover();
    assert.deepEqual(info.executionModes ?? [], expected);
  }
});

test('code launch, thread, and turn all request the restricted canonical workspace policy', async t => {
  const { workspace, policy, threadResponse } = codeFixture(t);
  const child = fakeChild({ threadResponse });
  const result = await adapterFor([child]).run({ ...runInput(new AbortController().signal), workspace, executionMode: 'code' });
  assert.equal(result.status, 'completed');
  const args = child.launch.args;
  for (const setting of ['sandbox_mode="workspace-write"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true', `sandbox_workspace_write.writable_roots=${JSON.stringify([workspace])}`, 'approval_policy="never"', 'project_doc_max_bytes=0']) assert.ok(args.includes(setting), setting);
  const thread = child.requests.find(request => request.method === 'thread/start').params;
  const turn = child.requests.find(request => request.method === 'turn/start').params;
  assert.equal(thread.sandbox, 'workspace-write');
  assert.equal(thread.approvalPolicy, 'never');
  assert.match(thread.baseInstructions, /edit/);
  assert.match(thread.baseInstructions, /Do not commit, merge, push/);
  assert.deepEqual(turn.sandboxPolicy, policy);
  assert.equal(turn.approvalPolicy, 'never');
});

test('code mode fails before turn dispatch for unverified version, missing or broader effective policy', async t => {
  const { workspace, policy, threadResponse } = codeFixture(t);
  for (const returned of [undefined, { ...threadResponse, approvalPolicy: 'on-request' }, { ...threadResponse, cwd: '/' }, { ...threadResponse, sandbox: { ...policy, networkAccess: true } }, { ...threadResponse, sandbox: { ...policy, writableRoots: [workspace, '/tmp'] } }, { ...threadResponse, sandbox: { ...policy, excludeSlashTmp: false } }, { ...threadResponse, sandbox: { ...policy, excludeTmpdirEnvVar: false } }, { ...threadResponse, sandbox: { type: 'dangerFullAccess' } }]) {
    const child = fakeChild({ threadResponse: returned });
    await assert.rejects(adapterFor([child]).run({ ...runInput(new AbortController().signal), workspace, executionMode: 'code' }), /policy|permissions|sandbox/i);
    assert.equal(child.methods.includes('turn/start'), false);
  }
  const child = fakeChild({ threadResponse });
  await assert.rejects(adapterFor([child], { execFile: () => 'codex-cli 0.150.0' }).run({ ...runInput(new AbortController().signal), workspace, executionMode: 'code' }), /version|verified/i);
  assert.equal(child.methods.length, 0);
});

test('code mode declines escalations and captures bounded native verification and change evidence', async t => {
  const { workspace, threadResponse } = codeFixture(t);
  const events = [];
  const child = fakeChild({ threadResponse, notifications: [
    { id: 91, method: 'item/commandExecution/requestApproval', params: {} },
    { id: 92, method: 'item/fileChange/requestApproval', params: {} },
    { id: 93, method: 'item/permissions/requestApproval', params: {} },
    { method: 'item/completed', params: { item: { id: 'check', type: 'commandExecution', command: 'node --test', exitCode: 1, aggregatedOutput: 'f'.repeat(100_000), status: 'completed', cwd: workspace } } },
    { method: 'item/completed', params: { item: { id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '+new' }] } } },
    { method: 'turn/diff/updated', params: { diff: '+new' } },
  ] });
  await adapterFor([child]).run({ ...runInput(new AbortController().signal, events), workspace, executionMode: 'code' });
  assert.deepEqual(child.replies.map(reply => reply.result), [{ decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }]);
  const check = events.find(event => event.type === 'command.completed');
  assert.equal(check.data.exitCode, 1);
  assert.equal(check.data.command, 'node --test');
  assert.ok(check.data.output.length < 100_000);
  assert.equal(check.data.outputTruncated, true);
  assert.ok(events.some(event => event.type === 'file.changed'));
  assert.ok(events.some(event => event.type === 'turn.diff' && event.data.diff === '+new'));
  assert.ok(events.filter(event => event.type === 'message.delta').every(event => !event.data.text.includes('secret command')));
});

test('code runs reject API-key accounts and redirected roots before any turn', async t => {
  const { workspace, threadResponse } = codeFixture(t);
  const child = fakeChild({ accountType: 'apiKey', threadResponse });
  await assert.rejects(adapterFor([child]).run({ ...runInput(new AbortController().signal), workspace, executionMode: 'code' }), /ChatGPT/);
  assert.equal(child.methods.includes('thread/start'), false);
  const redirected = join(workspace, 'redirected');
  symlinkSync(workspace, redirected);
  const unused = fakeChild({ threadResponse });
  await assert.rejects(adapterFor([unused]).run({ ...runInput(new AbortController().signal), workspace: redirected, executionMode: 'code' }), /canonical/);
  assert.equal(unused.methods.length, 0);
});

test('runCommand uses native argv execution with restricted policy, live output and no turn', async t => {
  const { workspace, policy, threadResponse } = codeFixture(t);
  const child = fakeChild({ threadResponse, commandResult: { exitCode: 2, stdout: '', stderr: '' } });
  const output = [];
  const result = await adapterFor([child]).runCommand({ workspace, command: ['/usr/bin/false'], signal: new AbortController().signal, onOutput: text => output.push(text) });
  const request = child.requests.find(value => value.method === 'command/exec').params;
  assert.deepEqual(request.command, ['/usr/bin/false']);
  assert.deepEqual(request.sandboxPolicy, policy);
  assert.equal(request.cwd, workspace);
  assert.equal(request.timeoutMs, 600_000);
  assert.equal(request.streamStdoutStderr, true);
  assert.ok(request.outputBytesCap > 0 && request.outputBytesCap <= 65_536);
  assert.ok(request.processId);
  assert.equal(child.methods.includes('turn/start'), false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'checks passed\n');
  assert.equal(output.join(''), result.output);
  assert.equal(result.cleanupVerified, true);
});

test('runCommand rejects incompatible authentication/version and reports bounded output', async t => {
  const { workspace, threadResponse } = codeFixture(t);
  for (const extra of [{ execFile: () => 'codex-cli 0.150.0' }, {}]) {
    const child = fakeChild({ accountType: 'apiKey', threadResponse });
    const result = await adapterFor([child], extra).runCommand({ workspace, command: ['/usr/bin/true'], signal: new AbortController().signal, onOutput: () => {} });
    assert.equal(result.exitCode, null);
    assert.ok(result.error);
    assert.equal(child.methods.includes('command/exec'), false);
  }
  const child = fakeChild({ threadResponse, commandOutput: 'x'.repeat(100_000) });
  const result = await adapterFor([child]).runCommand({ workspace, command: ['/usr/bin/true'], signal: new AbortController().signal, onOutput: () => {} });
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 65_536);
});

test('runCommand cancellation terminates the native command and never reports success', async t => {
  const { workspace, threadResponse } = codeFixture(t);
  const child = fakeChild({ threadResponse, commandDelay: 100 });
  const controller = new AbortController();
  const result = await adapterFor([child]).runCommand({ workspace, command: ['/usr/bin/true'], signal: controller.signal, onOutput: () => controller.abort() });
  assert.equal(result.exitCode, null);
  assert.match(result.error, /interrupt|cancel/i);
  assert.ok(child.methods.includes('command/exec/terminate'));
  assert.equal(result.cleanupVerified, true);
});

test('native normalization may omit the already writable cwd, but cannot add another root', async t => {
  const { workspace, policy, threadResponse } = codeFixture(t);
  const normalized = { ...threadResponse, sandbox: { ...policy, writableRoots: [] } };
  const codeChild = fakeChild({ threadResponse: normalized });
  const run = await adapterFor([codeChild]).run({ ...runInput(new AbortController().signal), workspace, executionMode: 'code' });
  assert.equal(run.status, 'completed');
  const commandChild = fakeChild({ threadResponse: normalized });
  const command = await adapterFor([commandChild]).runCommand({ workspace, command: ['/usr/bin/true'], signal: new AbortController().signal, onOutput: () => {} });
  assert.equal(command.exitCode, 0);
  assert.equal(command.error, undefined);
});

test('runCommand never executes when effective permissions cannot be verified', async t => {
  const { workspace } = codeFixture(t);
  const child = fakeChild();
  const result = await adapterFor([child]).runCommand({ workspace, command: ['/usr/bin/true'], signal: new AbortController().signal, onOutput: () => {} });
  assert.equal(result.exitCode, null);
  assert.match(result.error, /permissions|policy/);
  assert.equal(child.methods.includes('command/exec'), false);
});

test('GUI-hosted native execution has explicit installed toolchains while HOME stays in the workspace', async () => {
  const original = process.execPath;
  const child = fakeChild();
  let running;
  try {
    process.execPath = '/Applications/Randolph.app/Contents/MacOS/Electron';
    running = adapterFor([child]).run(runInput(new AbortController().signal));
  } finally { process.execPath = original; }
  await running;
  const setting = name => JSON.parse(child.launch.args.find(arg => arg.startsWith(`${name}=`)).slice(name.length + 1));
  const paths = setting('shell_environment_policy.set.PATH').split(delimiter);
  for (const directory of [join(homedir(), '.volta/bin'), join(homedir(), '.local/bin'), join(homedir(), '.pyenv/shims'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (existsSync(directory)) assert.ok(paths.includes(directory));
  }
  assert.ok(paths.includes('/usr/bin'));
  assert.equal(paths.includes('/Applications/Randolph.app/Contents/MacOS'), false);
  assert.equal(paths.includes('/fixture'), false);
  assert.equal(paths.includes(''), false);
  assert.equal(paths.includes('.'), false);
  assert.equal(setting('shell_environment_policy.set.VOLTA_HOME'), join(homedir(), '.volta'));
  assert.equal(setting('shell_environment_policy.set.HOME'), realpathSync(process.cwd()));
  assert.ok(child.launch.args.includes('shell_environment_policy.inherit="none"'));
});


test('explicit CLI discovery and execution use the selected copy instead of the default', async () => {
  const launched = [];
  const adapter = new CodexAdapter({ executable: 'default-codex', execFile: file => file === '/selected/codex' ? 'codex-cli selected' : 'codex-cli default', spawn: file => { launched.push(file); return fakeChild({ modelId: file === '/selected/codex' ? 'selected-model' : 'default-model' }); } });
  const info = await adapter.discover('/selected/codex');
  assert.equal(info.executable, '/selected/codex');
  assert.equal(info.version, 'codex-cli selected');
  assert.equal(info.models[0].id, 'selected-model');
  const events = [];
  await adapter.run({ ...runInput(new AbortController().signal, events), executable: info.executable, executableVersion: info.version });
  assert.deepEqual(launched, ['/selected/codex', '/selected/codex']);
  assert.equal(events.find(event => event.type === 'message.delta').data.text, 'selected-model');
});

test('an executable changed after admission cannot dispatch a run', async () => {
  let launched = false;
  const adapter = new CodexAdapter({ executable: '/selected/codex', execFile: () => 'codex-cli changed', spawn: () => { launched = true; return fakeChild(); } });
  await assert.rejects(adapter.run({ ...runInput(new AbortController().signal), executable: '/selected/codex', executableVersion: 'codex-cli admitted' }), /changed|version/i);
  assert.equal(launched, false);
});


test('verified 0.154 supports Code and checks with normalized effective writable roots', async t => {
  const { workspace, policy, threadResponse } = codeFixture(t);
  const response = { ...threadResponse, sandbox: { ...policy, writableRoots: [] } };
  const adapter = adapterFor([fakeChild({ threadResponse: response }), fakeChild({ threadResponse: response })], { execFile: () => 'codex-cli 0.154.0' });
  const result = await adapter.run({ ...runInput(new AbortController().signal), workspace, executionMode: 'code' });
  assert.equal(result.status, 'completed');
  const check = await adapter.runCommand({ workspace, command: ['/bin/echo', 'ok'], signal: new AbortController().signal, onOutput() {} });
  assert.equal(check.exitCode, 0);
  assert.equal(check.cleanupVerified, true);
});
