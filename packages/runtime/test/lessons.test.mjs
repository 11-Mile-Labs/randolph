import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Lessons } from '../dist/lessons.js';

const manual = { projectAutoApprove: false, globalAutoApprove: false, revision: 'config-v1' };
const draft = (overrides = {}) => ({ scope: { kind: 'project', projectId: 'project-a' }, title: 'Validate changes', text: 'Run the existing checks before delivery.', tags: ['testing'], evidence: [{ label: 'Review result', uri: 'randolph://runs/source-run' }], ...overrides });
const ref = lesson => ({ lessonId: lesson.lessonId, version: lesson.version });
function fixture(t) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); return { db, lessons: new Lessons(db) }; }

test('project and global approval settings apply independently without retroactive approval', t => {
  const { lessons } = fixture(t);
  const project = lessons.create(draft(), manual);
  const global = lessons.create(draft({ scope: { kind: 'global' } }), { ...manual, projectAutoApprove: true });
  const automatic = lessons.create(draft(), { ...manual, projectAutoApprove: true });
  assert.equal(project.status, 'draft'); assert.equal(global.status, 'draft'); assert.equal(automatic.status, 'approved');
  assert.deepEqual(automatic.approvalSettings, { ...manual, projectAutoApprove: true });
  assert.deepEqual(lessons.retrieve({ projectId: 'project-a' }).lessons.map(ref), [ref(automatic)]);
  lessons.approve([ref(project), ref(global)]);
  assert.equal(lessons.retrieve({ projectId: 'project-a' }).lessons.length, 3);
});

test('edits preserve evidence and exact previous versions while revoking approval until reviewed', t => {
  const { lessons } = fixture(t);
  const original = lessons.create(draft(), manual); lessons.approve([ref(original)]);
  const edited = lessons.edit(ref(original), { title: 'Revised', text: 'Run tests and inspect the diff.' }, manual);
  assert.equal(edited.version, 2); assert.equal(edited.status, 'draft');
  const history = lessons.history(original.lessonId);
  assert.equal(history[0].text, original.text); assert.equal(history[0].status, 'superseded');
  assert.deepEqual(history[0].supersededBy, ref(edited));
  assert.deepEqual(edited.evidence, original.evidence);
  assert.equal(lessons.retrieve({ projectId: 'project-a' }).lessons.length, 0);
  assert.throws(() => lessons.edit(ref(original), { text: 'stale overwrite' }, manual), /stale|current/i);
});

test('group decisions are atomic and rejection or supersession can be reversed with preserved history', t => {
  const { lessons } = fixture(t);
  const first = lessons.create(draft(), manual); const second = lessons.create(draft({ title: 'Second' }), manual);
  assert.throws(() => lessons.approve([ref(first), { lessonId: second.lessonId, version: 99 }]), /stale|version/i);
  assert.equal(lessons.history(first.lessonId)[0].status, 'draft');
  lessons.reject([ref(first), ref(second)]);
  lessons.approve([ref(first)]);
  lessons.supersede(ref(first), ref(second));
  const restored = lessons.restore(first.lessonId, 1, 1, manual);
  assert.equal(restored.version, 2); assert.equal(restored.text, first.text); assert.equal(restored.status, 'draft');
  assert.deepEqual(lessons.events(first.lessonId).map(event => event.action), ['created', 'rejected', 'approved', 'superseded', 'restored']);
});

test('retrieval filters scope, text, tags and exact framework/version applicability', t => {
  const { lessons } = fixture(t);
  const settings = { ...manual, projectAutoApprove: true, globalAutoApprove: true };
  const applicable = lessons.create(draft({ scope: { kind: 'global' }, applicability: [{ framework: 'Next.js', versions: ['16'] }] }), settings);
  lessons.create(draft({ scope: { kind: 'project', projectId: 'project-b' } }), settings);
  lessons.create(draft({ title: 'Different topic', text: 'Water the trees.', tags: ['gardening'] }), settings);
  assert.deepEqual(lessons.retrieve({ projectId: 'project-a', query: 'checks', tags: ['testing'], frameworks: { 'Next.js': '16' } }).lessons.map(ref), [ref(applicable)]);
  assert.equal(lessons.retrieve({ projectId: 'project-a', query: 'checks', frameworks: { 'Next.js': '15' } }).lessons.length, 0);
  assert.equal(lessons.retrieve({ projectId: 'project-a', query: 'checks' }).lessons.length, 0);
});

test('pinned and explicitly selected versions are never silently dropped by result limits', t => {
  const { lessons } = fixture(t); const settings = { ...manual, projectAutoApprove: true };
  const first = lessons.create(draft(), settings); const second = lessons.create(draft({ title: 'Other' }), settings);
  lessons.pin('project-a', ref(first), true);
  const result = lessons.retrieve({ projectId: 'project-a', query: 'unmatched', limit: 1, selected: [ref(second)] });
  assert.deepEqual(result.lessons.map(ref), [ref(first), ref(second)]); assert.equal(result.limitExceeded, true);
  const next = lessons.edit(ref(first), { text: 'Changed pinned lesson.' }, settings);
  const blocked = lessons.retrieve({ projectId: 'project-a' });
  assert.deepEqual(blocked.blockedPins.map(value => value.reference), [ref(first)]);
  assert.ok(blocked.blockedPins[0].reason);
  lessons.pin('project-a', ref(next), true);
  assert.equal(lessons.retrieve({ projectId: 'project-a' }).blockedPins.length, 0);
  lessons.pin('project-a', ref(next), false);
  assert.equal(lessons.pins('project-a').length, 0);
});

test('pins and explicit selections cannot bypass approval, project boundaries or applicability', t => {
  const { lessons } = fixture(t);
  const pending = lessons.create(draft(), manual);
  assert.throws(() => lessons.pin('project-a', ref(pending), true), /approved/i);
  lessons.approve([ref(pending)]);
  assert.throws(() => lessons.pin('project-b', ref(pending), true), /scope|project/i);
  const framework = lessons.create(draft({ applicability: [{ framework: 'React', versions: ['19'] }] }), { ...manual, projectAutoApprove: true });
  lessons.pin('project-a', ref(framework), true);
  const result = lessons.retrieve({ projectId: 'project-a', selected: [ref(pending), { lessonId: 'unknown', version: 1 }] });
  assert.equal(result.blockedPins.length, 1); assert.equal(result.blockedSelections.length, 1);
});

test('supplied versions and approval provenance stay immutable when later lessons change', t => {
  const { db, lessons } = fixture(t);
  const initial = lessons.create(draft(), { ...manual, projectAutoApprove: true });
  lessons.pin('project-a', ref(initial), true);
  assert.throws(() => lessons.recordUse({ projectId: 'project-a', runId: 'run-1', agentId: 'agent-1', references: [] }), /pinned/i);
  const use = lessons.recordUse({ projectId: 'project-a', runId: 'run-1', agentId: 'agent-1', references: [ref(initial)] });
  lessons.edit(ref(initial), { text: 'Later knowledge.' }, manual);
  const reopened = new Lessons(db);
  assert.deepEqual(reopened.usage('run-1', 'agent-1'), use);
  assert.equal(use.lessons[0].text, initial.text); assert.equal(use.lessons[0].status, 'approved');
  assert.throws(() => reopened.recordUse({ projectId: 'project-a', runId: 'run-1', agentId: 'agent-1', references: [] }), /already|recorded/i);
});

test('lesson schema does not change the application version and rejects future lesson schema', t => {
  const { db } = fixture(t);
  db.exec('PRAGMA user_version=42'); new Lessons(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 42);
  db.exec('UPDATE lesson_schema SET version=99 WHERE id=1');
  assert.throws(() => new Lessons(db), /newer|schema/i);
});
