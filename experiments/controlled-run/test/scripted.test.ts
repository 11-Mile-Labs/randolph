import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedServer, scriptedToolResponse } from '../src/scripted-server.js';
import { matchesApproval, matchesCommand } from '../src/scripted-git.js';
import { Journal } from '../src/evidence.js';
import { launchArguments } from '../src/codex.js';

const call = { id: 'case1', command: 'git commit --allow-empty -m fixture', cwd: process.cwd(), escalated: false };
test('scripted response requests the real native shell tool with exact arguments', () => {
  const events = scriptedToolResponse(call).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const item = events.find(event => event.type === 'response.output_item.done').item;
  assert.equal(item.name, 'shell_command');
  assert.equal(item.call_id, call.id);
  assert.deepEqual(JSON.parse(item.arguments), { command: call.command, workdir: call.cwd, timeout_ms: 5000 });
  const escalated = scriptedToolResponse({ ...call, escalated: true });
  assert.ok(escalated.includes('require_escalated'));
});
test('positive control approval requires exact call, command and worktree', () => {
  const params = { itemId: call.id, command: call.command, cwd: call.cwd, availableDecisions: ['accept', 'decline'] };
  assert.equal(matchesApproval(params, call), true);
  for (const change of [{ itemId: 'other' }, { command: call.command + '; touch other' }, { cwd: '/' }, { availableDecisions: ['decline'] }]) {
    assert.equal(matchesApproval({ ...params, ...change }, call), false);
  }
  assert.equal(matchesCommand(`/bin/zsh -lc '${call.command}'`, call.command), true);
  assert.equal(matchesCommand(`/bin/zsh -lc echo misleading; '${call.command}'`, call.command), false);
});
test('scripted launch uses a distinct no-auth provider with no retry or subscription fallback', () => {
  const args = launchArguments('/fixture/work', [], { home: '/fixture/home', endpoint: 'http://127.0.0.1:12345/v1' });
  assert.ok(args.includes('model_provider="randolph_fixture"'));
  assert.ok(args.includes('model_providers.randolph_fixture.requires_openai_auth=false'));
  assert.ok(args.includes('model_providers.randolph_fixture.supports_websockets=false'));
  assert.ok(args.includes('model_providers.randolph_fixture.request_max_retries=0'));
  assert.ok(!args.includes('forced_login_method="chatgpt"'));
});
test('loopback fixture requires the correlated tool output before returning a final response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'randolph-scripted-'));
  const server = new ScriptedServer(new Journal(dir));
  try {
    await server.start();
    server.prepare(call);
    const post = async (input: unknown[]) => fetch(server.endpoint + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', input }) });
    const first = await post([]);
    assert.equal(first.status, 200);
    assert.ok((await first.text()).includes('shell_command'));
    assert.throws(() => server.prepare(call), /incomplete/);
    const second = await post([{ type: 'function_call_output', call_id: call.id, output: 'real tool receipt' }]);
    assert.equal(second.status, 200);
    await second.text();
    assert.equal(server.complete(), true);
    assert.equal(server.requests.length, 2);
    const unexpected = await post([]);
    assert.equal(unexpected.status, 400);
    await unexpected.text();
    assert.equal(server.complete(), false);
  } finally { await server.close(); rmSync(dir, { recursive: true }); }
});
test('loopback fixture rejects missing results and authentication headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'randolph-scripted-'));
  const server = new ScriptedServer(new Journal(dir));
  try {
    await server.start();
    server.prepare(call);
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', input: [] }) };
    const first = await fetch(server.endpoint + '/responses', request); await first.text();
    const absent = await fetch(server.endpoint + '/responses', request); await absent.text();
    assert.equal(absent.status, 400);
    const auth = await fetch(server.endpoint + '/responses', { ...request, headers: { authorization: 'synthetic-rejected' } }); await auth.text();
    assert.equal(auth.status, 400);
    assert.equal(server.complete(), false);
  } finally { await server.close(); rmSync(dir, { recursive: true }); }
});
