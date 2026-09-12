import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexAdapter } from '../dist/index.js';

function fakeChild({ accountType = 'chatgpt', modelId = 'gpt-test', delayInitialize = 0, turnStatus = 'completed', invalid = false } = {}) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.methods = [];
  let threadId = '';
  const send = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...rest) => {
    const request = JSON.parse(String(chunk));
    child.methods.push(request.method);
    const respond = () => {
      if (invalid) { child.stdout.write('{not-json}\n'); return; }
      if (request.method === 'account/read') send({ id: request.id, result: { account: { type: accountType } } });
      else if (request.method === 'model/list') send({ id: request.id, result: { data: [{ model: modelId, displayName: 'Test Model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] } });
      else if (request.method === 'thread/start') { threadId = 'thread-' + Math.random().toString(16).slice(2); send({ id: request.id, result: { thread: { id: threadId } } }); }
      else if (request.method === 'turn/start') {
        send({ id: request.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'item/commandExecution/delta', params: { itemId: 'command-1', delta: 'secret command' } });
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
  return new CodexAdapter({ executable: 'fake-codex', spawn: (_file, args, options) => {
    const child = children.shift();
    assert.ok(child, 'unexpected native process launch');
    child.launch = { args, options };
    return child;
  }, ...extra });
}

const runInput = (signal, events = [], model = 'gpt-test') => ({ workspace: '/fixture', model, effort: 'low', messages: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'prior answer' }], signal, onEvent: (event) => events.push(event) });

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
