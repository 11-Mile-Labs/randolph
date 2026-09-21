import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUIMessageStream } from 'ai';
import {
  RandolphChatTransport,
  projectChatMessages,
  NativeChatSession,
} from '../dist/chat-transport.js';

function fixture() {
  const listeners = new Set();
  const snapshot = {
    projects: [],
    conversations: [],
    runs: [],
    messages: [],
    events: [],
    reviews: [],
    dataRoot: '',
  };
  const calls = [];
  const stops = [];
  const run = {
    id: 'r1',
    conversationId: 'c1',
    projectId: 'p1',
    status: 'running',
    createdAt: '2026-09-12T12:00:00Z',
  };
  let sequence = 0;
  const bridge = {
    async snapshot() {
      return structuredClone({ ...snapshot, events: snapshot.events.slice(-2000) });
    },
    async chatEvents({ conversationId, runId, afterSequence }) {
      return structuredClone({
        run: snapshot.runs.find(
          (item) => item.id === runId && item.conversationId === conversationId,
        ),
        events: snapshot.events.filter(
          (event) =>
            event.runId === runId &&
            event.conversationId === conversationId &&
            event.sequence > afterSequence,
        ),
      });
    },
    onChanged(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async send(input) {
      calls.push(input);
      snapshot.runs.push(run);
      snapshot.messages.push({
        id: 'u1',
        runId: run.id,
        conversationId: 'c1',
        role: 'user',
        text: input.text,
        createdAt: run.createdAt,
      });
      return structuredClone(run);
    },
    async stop(id) {
      stops.push(id);
      run.status = 'interrupted';
      changed();
    },
  };
  function changed() {
    for (const fn of listeners) fn();
  }
  function event(type, data, overrides = {}) {
    snapshot.events.push({
      sequence: ++sequence,
      runId: run.id,
      conversationId: 'c1',
      type,
      data,
      at: run.createdAt,
      ...overrides,
    });
    changed();
  }
  function delta(id, text) {
    event('message.delta', { messageId: id, text });
    let message = snapshot.messages.find((m) => m.id === `${run.id}:${id}`);
    if (!message) {
      message = {
        id: `${run.id}:${id}`,
        runId: run.id,
        conversationId: 'c1',
        role: 'assistant',
        text: '',
        createdAt: run.createdAt,
      };
      snapshot.messages.push(message);
    }
    message.text += text;
  }
  return { snapshot, run, calls, stops, bridge, listeners, event, delta, changed };
}
const options = {
  trigger: 'submit-message',
  chatId: 'c1',
  messageId: undefined,
  messages: [{ id: 'optimistic', role: 'user', parts: [{ type: 'text', text: 'Inspect' }] }],
  abortSignal: undefined,
};
async function collect(stream) {
  let last;
  for await (const message of readUIMessageStream({ stream, terminateOnError: true }))
    last = message;
  return last;
}

test('native events stream once, keep native parts, and exclude other runs and tool output', async () => {
  const f = fixture();
  const transport = new RandolphChatTransport(f.bridge, 'c1');
  const result = collect(await transport.sendMessages(options));
  f.delta('intro', 'Looking.');
  f.event('command.completed', { text: 'PRIVATE TOOL OUTPUT' });
  f.event(
    'message.delta',
    { messageId: 'answer', text: 'WRONG RUN' },
    { runId: 'r2', conversationId: 'c2' },
  );
  f.delta('answer', 'Hello');
  f.changed();
  f.delta('answer', ' world');
  f.run.status = 'completed';
  f.changed();
  const message = await result;
  assert.equal(message.id, 'r1:assistant');
  assert.deepEqual(
    message.parts.map((p) => p.text),
    ['Looking.', 'Hello world'],
  );
  assert.deepEqual(f.calls, [{ conversationId: 'c1', text: 'Inspect' }]);
  assert.equal(f.listeners.size, 0);
});

test('reconnect reconstructs the same run from durable events and never dispatches', async () => {
  const f = fixture();
  await f.bridge.send({ text: 'Inspect' });
  f.delta('answer', 'Before');
  const transport = new RandolphChatTransport(f.bridge, 'c1');
  const result = collect(await transport.reconnectToStream({ chatId: 'c1' }));
  f.delta('answer', ' after');
  f.run.status = 'completed';
  f.changed();
  assert.equal((await result).parts[0].text, 'Before after');
  assert.equal(f.calls.length, 1);
  assert.equal(await transport.reconnectToStream({ chatId: 'c1' }), null);
  assert.equal(f.calls.length, 1);
});

test('explicit cancellation stops the admitted run; detaching the view does not', async () => {
  const f = fixture();
  const transport = new RandolphChatTransport(f.bridge, 'c1');
  const signal = new AbortController();
  const result = collect(await transport.sendMessages({ ...options, abortSignal: signal.signal }));
  signal.abort();
  await result;
  assert.deepEqual(f.stops, ['r1']);
  assert.equal(f.listeners.size, 0);
  const other = fixture();
  const view = new RandolphChatTransport(other.bridge, 'c1');
  const detached = collect(await view.sendMessages(options));
  view.dispose();
  await detached;
  assert.deepEqual(other.stops, []);
  assert.equal(other.listeners.size, 0);
});

test('cancellation during admission stops precisely the returned run and never retries', async () => {
  const f = fixture();
  const admitted = Promise.withResolvers();
  f.bridge.send = async (input) => {
    f.calls.push(input);
    await admitted.promise;
    f.snapshot.runs.push(f.run);
    return f.run;
  };
  const signal = new AbortController();
  const transport = new RandolphChatTransport(f.bridge, 'c1');
  const pending = transport.sendMessages({ ...options, abortSignal: signal.signal });
  signal.abort();
  admitted.resolve();
  await collect(await pending);
  assert.deepEqual(f.stops, ['r1']);
  assert.equal(f.calls.length, 1);
});

test('stream errors unsubscribe and do not retry a turn; unsupported operations cannot dispatch', async () => {
  const f = fixture();
  const transport = new RandolphChatTransport(f.bridge, 'c1');
  await assert.rejects(
    transport.sendMessages({ ...options, trigger: 'regenerate-message' }),
    /Run history/,
  );
  await assert.rejects(transport.sendMessages({ ...options, chatId: 'other' }), /conversation/);
  assert.equal(f.calls.length, 0);
  f.bridge.chatEvents = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(collect(await transport.sendMessages(options)), /Storage unavailable/);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.length, 1);
});

test('SDK session acknowledges admission and reconciles optimistic messages with SQLite identity', async () => {
  const f = fixture();
  const session = new NativeChatSession(f.bridge, 'c1', structuredClone(f.snapshot));
  await session.send('Inspect');
  assert.equal(f.calls.length, 1);
  f.delta('answer', 'Result');
  f.run.status = 'completed';
  f.changed();
  await session.settled;
  assert.deepEqual(session.chat.messages, projectChatMessages(f.snapshot, 'c1'));
  assert.equal(session.chat.messages[0].id, 'u1');
  session.dispose();
});

test('SDK reconnect replaces an existing partial response without duplicates or another turn', async () => {
  const f = fixture();
  await f.bridge.send({ text: 'Inspect' });
  f.delta('answer', 'Before');
  const session = new NativeChatSession(f.bridge, 'c1', structuredClone(f.snapshot));
  const connected = session.connect();
  f.delta('answer', ' after');
  f.run.status = 'completed';
  f.changed();
  await connected;
  assert.equal(session.chat.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(session.chat.messages.at(-1).parts[0].text, 'Before after');
  assert.equal(f.calls.length, 1);
  assert.equal(f.listeners.size, 0);
  session.dispose();
});

test('SDK admission errors restore durable history and preserve the unsent request for the caller', async () => {
  const f = fixture();
  f.bridge.send = async () => {
    throw new Error('Model unavailable');
  };
  const session = new NativeChatSession(f.bridge, 'c1', structuredClone(f.snapshot));
  await assert.rejects(session.send('Inspect'), /Model unavailable/);
  await session.settled;
  assert.deepEqual(session.chat.messages, []);
  assert.equal(session.chat.error.message, 'Model unavailable');
  assert.equal(f.listeners.size, 0);
  session.dispose();
});

test('development effect cleanup and reattachment do not permanently close a chat session', async () => {
  const f = fixture();
  const session = new NativeChatSession(f.bridge, 'c1', structuredClone(f.snapshot));
  const detach = session.attach();
  detach();
  const detachAgain = session.attach();
  await new Promise((resolve) => setImmediate(resolve));
  await session.send('Inspect');
  f.run.status = 'completed';
  f.changed();
  await session.settled;
  assert.equal(f.calls.length, 1);
  detachAgain();
});

test('changes arriving during a scoped event read are drained after that read without losing deltas', async () => {
  const f = fixture();
  const firstRead = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  const read = f.bridge.chatEvents;
  let delay = true;
  f.bridge.chatEvents = async (input) => {
    const captured = await read(input);
    if (delay) {
      delay = false;
      readStarted.resolve();
      await firstRead.promise;
    }
    return captured;
  };
  const transport = new RandolphChatTransport(f.bridge, 'c1');
  const output = collect(await transport.sendMessages(options));
  await readStarted.promise;
  f.delta('answer', 'Arrived during read');
  for (let i = 0; i < 2100; i++)
    f.event('command.output', { text: 'other' }, { runId: 'r2', conversationId: 'c2' });
  f.run.status = 'completed';
  f.changed();
  firstRead.resolve();
  assert.equal((await output).parts[0].text, 'Arrived during read');
  assert.equal(f.listeners.size, 0);
});

test('recovered conversation preserves imported turns and streams only the new response', async () => {
  const f = fixture();
  await f.bridge.send({ text: 'Last question' });
  f.snapshot.messages = ['Old question', 'Old answer', 'Last question'].map((text, index) => ({
    id: `r1:recovery:${index}`,
    runId: 'r1',
    conversationId: 'c1',
    role: index === 1 ? 'assistant' : 'user',
    text,
    createdAt: f.run.createdAt,
  }));
  f.delta('answer', 'New');
  const session = new NativeChatSession(f.bridge, 'c1', await f.bridge.snapshot());
  assert.deepEqual(
    session.chat.messages.map((m) => m.id),
    ['r1:recovery:0', 'r1:recovery:1', 'r1:recovery:2', 'r1:assistant'],
  );
  const connected = session.connect();
  f.delta('answer', ' answer');
  f.run.status = 'completed';
  f.changed();
  await connected;
  assert.deepEqual(
    session.chat.messages.map((m) => m.parts[0].text),
    ['Old question', 'Old answer', 'Last question', 'New answer'],
  );
  assert.equal(f.calls.length, 1);
  session.dispose();
});

test('reconnect retains the prefix when other conversations exceed the workspace event window', async () => {
  const f = fixture();
  await f.bridge.send({ text: 'Inspect' });
  f.delta('answer', 'Retained prefix');
  for (let i = 0; i < 2100; i++)
    f.event('command.output', { text: 'other' }, { runId: 'r2', conversationId: 'c2' });
  assert.equal(
    (await f.bridge.snapshot()).events.some((event) => event.runId === 'r1'),
    false,
  );
  const session = new NativeChatSession(f.bridge, 'c1', await f.bridge.snapshot());
  const connected = session.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.chat.messages.at(-1).parts[0].text, 'Retained prefix');
  f.delta('answer', ' and suffix');
  f.run.status = 'completed';
  f.changed();
  await connected;
  assert.equal(session.chat.messages.at(-1).parts[0].text, 'Retained prefix and suffix');
  assert.equal(f.calls.length, 1);
  session.dispose();
});
