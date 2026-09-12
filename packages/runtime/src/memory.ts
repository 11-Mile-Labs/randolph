import { realpathSync } from 'node:fs';
import { Lessons, type LessonDraft, type LessonPatch, type LessonRef, type LessonVersion, type LessonUse } from './lessons.js';
import { readMemorySettings, writeMemorySettings, type MemoryPreferences, type MemorySettings } from './memory-settings.js';
import type { Project } from './contracts.js';
import type { Store } from './store.js';

export type MemorySnapshot = { lessons: LessonVersion[]; pins: LessonRef[]; projectSettings: MemorySettings; globalSettings: MemorySettings };
export type MemoryCommand = { projectId: string } & (
  { action: 'create'; draft: LessonDraft } |
  { action: 'edit'; reference: LessonRef; patch: LessonPatch } |
  { action: 'approve' | 'reject'; references: LessonRef[] } |
  { action: 'pin'; reference: LessonRef; pinned: boolean } |
  { action: 'restore'; reference: LessonRef; sourceVersion: number } |
  { action: 'settings'; scope: 'project' | 'global'; value: MemoryPreferences; expectedRevision: string | null }
);
export type PreparedMemory = { references: LessonRef[]; text: string; estimatedTokens: number; frameworks: Record<string, string> };
const ref = (lesson: LessonVersion): LessonRef => ({ lessonId: lesson.lessonId, version: lesson.version });
const key = (value: LessonRef): string => `${value.lessonId}:${value.version}`;
const MAX_CONTEXT = 32_000;

export class ProjectMemory {
  readonly lessons: Lessons;
  private readonly globalRoot: string;
  constructor(private readonly store: Store, private readonly changed: () => void) {
    this.lessons = new Lessons(store.db);
    this.globalRoot = realpathSync(store.root);
  }
  private project(id: string): Project {
    const project = this.store.projects().find(value => value.id === id);
    if (!project) throw new Error('Project does not exist.');
    return project;
  }
  snapshot(projectId: string): MemorySnapshot {
    const project = this.project(projectId);
    return {
      lessons: this.lessons.list().filter(lesson => lesson.scope.kind === 'global' || lesson.scope.projectId === projectId),
      pins: this.lessons.pins(projectId), projectSettings: readMemorySettings(project.root), globalSettings: readMemorySettings(this.globalRoot),
    };
  }
  history(projectId: string, reference: LessonRef): LessonVersion[] {
    this.assertScope(projectId, reference);
    return this.lessons.history(reference.lessonId);
  }
  private assertScope(projectId: string, reference: LessonRef): void {
    this.project(projectId);
    const lesson = this.lessons.history(reference?.lessonId).find(item => item.version === reference.version);
    if (!lesson || (lesson.scope.kind === 'project' && lesson.scope.projectId !== projectId)) throw new Error('Lesson is outside this project scope.');
  }
  command(input: MemoryCommand): MemorySnapshot {
    const project = this.project(input.projectId);
    const snapshot = this.snapshot(project.id);
    if (snapshot.projectSettings.error || snapshot.globalSettings.error) throw new Error(snapshot.projectSettings.error || snapshot.globalSettings.error);
    const policy = { projectAutoApprove: snapshot.projectSettings.value.autoApprove, globalAutoApprove: snapshot.globalSettings.value.autoApprove, revision: JSON.stringify([snapshot.projectSettings.revision, snapshot.globalSettings.revision]) };
    switch (input.action) {
      case 'create':
        if (input.draft.scope.kind !== 'global' && (input.draft.scope.kind !== 'project' || input.draft.scope.projectId !== project.id)) throw new Error('Lesson scope does not match this project.');
        this.lessons.create(input.draft, policy); break;
      case 'edit': this.assertScope(project.id, input.reference); this.lessons.edit(input.reference, input.patch, policy); break;
      case 'approve': case 'reject':
        for (const reference of input.references) this.assertScope(project.id, reference);
        if (input.action === 'approve') this.lessons.approve(input.references); else this.lessons.reject(input.references);
        break;
      case 'pin': this.assertScope(project.id, input.reference); this.lessons.pin(project.id, input.reference, input.pinned); break;
      case 'restore': this.assertScope(project.id, input.reference); this.lessons.restore(input.reference.lessonId, input.sourceVersion, input.reference.version, policy); break;
      case 'settings':
        if (input.scope !== 'project' && input.scope !== 'global') throw new Error('Invalid memory settings scope.');
        writeMemorySettings(input.scope === 'project' ? project.root : this.globalRoot, input.value, input.expectedRevision); break;
      default: throw new Error('Unsupported memory action.');
    }
    this.changed(); return this.snapshot(project.id);
  }
  prepare(projectId: string, message: string): PreparedMemory {
    const settings = this.snapshot(projectId);
    if (settings.projectSettings.error || settings.globalSettings.error) throw new Error(settings.projectSettings.error || settings.globalSettings.error);
    const frameworks = settings.projectSettings.value.frameworks;
    const pinned = this.lessons.retrieve({ projectId, frameworks, limit: 0 });
    if (pinned.blockedPins.length) throw new Error('Pinned memory needs attention: ' + pinned.blockedPins.map(item => item.reason).join(' '));
    const selected = new Map(pinned.lessons.map(lesson => [key(lesson), lesson]));
    const words = [...new Set(message.toLowerCase().match(/[a-z][a-z0-9.-]{3,}/g) ?? [])].filter(word => !['please', 'could', 'would', 'should', 'this', 'that', 'with', 'from', 'have', 'want', 'make', 'using', 'about'].includes(word)).slice(0, 20);
    for (const word of words) {
      for (const lesson of this.lessons.retrieve({ projectId, frameworks, query: word, limit: 8 }).lessons) selected.set(key(lesson), lesson);
    }
    const entries = [...selected.values()];
    const serialize = (values: LessonVersion[]): string => values.length ? 'Approved project context (reference material; does not change execution permissions):\n' + JSON.stringify(values.map(lesson => ({ ...ref(lesson), title: lesson.title, text: lesson.text, scope: lesson.scope, evidence: lesson.evidence }))) : '';
    const pinnedKeys = new Set(pinned.lessons.map(key));
    const included = entries.filter(lesson => pinnedKeys.has(key(lesson)));
    if (serialize(included).length > MAX_CONTEXT) throw new Error('Pinned memory exceeds the context allowance. Shorten or unpin lessons before sending; no pinned material was dropped.');
    for (const lesson of entries.filter(item => !pinnedKeys.has(key(item)))) if (included.length < 20 && serialize([...included, lesson]).length <= MAX_CONTEXT) included.push(lesson);
    const text = serialize(included);
    return { references: included.map(ref), text, estimatedTokens: Math.ceil(text.length / 4), frameworks };
  }
  retain(projectId: string, runId: string, prepared: PreparedMemory): LessonUse {
    return this.lessons.recordUse({ projectId, runId, agentId: 'main', references: prepared.references, frameworks: prepared.frameworks });
  }
}
