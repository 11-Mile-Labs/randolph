import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../dist/index.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'randolph-memory-'));
  const calls = [];
  const runtime = new Runtime({
    async discover() { return { available: true, authenticated: true, cleanupVerified: true, executable: '/fixture-codex', version: 'fixture-1', models: [{ id: 'fixture', name: 'Fixture', efforts: ['low'], defaultEffort: 'low' }] }; },
    async run(input) { calls.push(input); input.onEvent({ type: 'session.turn-started', summary: 'fixture turn established', data: { threadId: 'memory-thread', turnId: `memory-turn-${calls.length}` } }); return { status: 'completed' }; },
  }, join(root, 'data'));
  for (const name of ['a', 'b']) mkdirSync(join(root, name));
  const first = runtime.addProject(join(root, 'a')); const second = runtime.addProject(join(root, 'b'));
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, runtime, calls, first, second };
}
const reference = value => ({ lessonId: value.lessonId, version: value.version });
function create(f, project, title, text, scope = { kind: 'project', projectId: project.id }) {
  return f.runtime.memoryCommand({ projectId: project.id, action: 'create', draft: { scope, title, text } }).lessons.at(-1);
}
async function settle(runtime) { for (let i = 0; i < 100 && runtime.hasActiveWork(); i++) await new Promise(resolve => setTimeout(resolve, 5)); }

test('only relevant approved scoped lessons reach the agent and exact context survives later edits', async t => {
  const f = fixture(t);
  const approved = create(f, f.first, 'Database migrations', 'Migrations must preserve existing rows.');
  create(f, f.first, 'Draft migrations', 'This is not approved.');
  const unrelated = create(f, f.first, 'Gardening', 'Water the plants.', { kind: 'global' });
  const foreign = create(f, f.second, 'Migrations elsewhere', 'Private second project lesson.');
  f.runtime.memoryCommand({ projectId: f.first.id, action: 'approve', references: [reference(approved), reference(unrelated)] });
  f.runtime.memoryCommand({ projectId: f.second.id, action: 'approve', references: [reference(foreign)] });
  const conversation = f.runtime.createConversation(f.first.id);
  const run = await f.runtime.send({ conversationId: conversation.id, text: 'Review database migrations' });
  await settle(f.runtime);
  assert.match(JSON.stringify(f.calls[0].messages), /preserve existing rows/);
  assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /not approved|plants|second project/);
  f.runtime.memoryCommand({ projectId: f.first.id, action: 'edit', reference: reference(approved), patch: { text: 'Changed after dispatch.' } });
  const manifest = JSON.parse(readFileSync(join(f.runtime.store.runDirectory(run), 'manifest.json'), 'utf8'));
  assert.match(manifest.memory.text, /preserve existing rows/);
  assert.equal(manifest.memory.references[0].version, 1);
  assert.equal(f.runtime.memorySnapshot(f.first.id).lessons.find(item => item.lessonId === approved.lessonId).status, 'draft');
});

test('edited pinned lessons block dispatch until explicitly repinned or removed', async t => {
  const f = fixture(t);
  const lesson = create(f, f.first, 'Always retain evidence', 'Keep the source evidence.');
  f.runtime.memoryCommand({ projectId: f.first.id, action: 'approve', references: [reference(lesson)] });
  f.runtime.memoryCommand({ projectId: f.first.id, action: 'pin', reference: reference(lesson), pinned: true });
  f.runtime.memoryCommand({ projectId: f.first.id, action: 'edit', reference: reference(lesson), patch: { text: 'Keep revised evidence.' } });
  const conversation = f.runtime.createConversation(f.first.id);
  await assert.rejects(f.runtime.send({ conversationId: conversation.id, text: 'Inspect files' }), /pinned|memory/i);
  assert.equal(f.calls.length, 0);
  f.runtime.memoryCommand({ projectId: f.first.id, action: 'pin', reference: reference(lesson), pinned: false });
  await f.runtime.send({ conversationId: conversation.id, text: 'Inspect files' });
  await settle(f.runtime); assert.equal(f.calls.length, 1);
});

test('project approval preferences use editable YAML with stale-write protection and independent global policy', t => {
  const f = fixture(t);
  const initial = f.runtime.memorySnapshot(f.first.id);
  f.runtime.memoryCommand({ projectId: f.first.id, action: 'settings', scope: 'project', value: { autoApprove: true, frameworks: { React: '19' } }, expectedRevision: initial.projectSettings.revision });
  assert.equal(create(f, f.first, 'React effects', 'Keep effects bounded.').status, 'approved');
  assert.equal(create(f, f.first, 'Global approval', 'Requires separate approval.', { kind: 'global' }).status, 'draft');
  const saved = f.runtime.memorySnapshot(f.first.id);
  const path = join(f.first.root, 'config.memory.yaml');
  writeFileSync(path, readFileSync(path, 'utf8') + '# external edit\n');
  assert.throws(() => f.runtime.memoryCommand({ projectId: f.first.id, action: 'settings', scope: 'project', value: { autoApprove: false, frameworks: {} }, expectedRevision: saved.projectSettings.revision }), /changed|reload/i);
  assert.match(readFileSync(path, 'utf8'), /external edit/);
});
