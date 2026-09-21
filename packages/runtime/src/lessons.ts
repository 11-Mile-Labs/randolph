import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  LessonApprovalSettings,
  LessonDraft,
  LessonEvent,
  LessonPatch,
  LessonRef,
  LessonRetrieval,
  LessonRetrievalInput,
  LessonUse,
  LessonVersion,
} from './lesson-types.js';
import {
  applicable,
  approvalSettings,
  bounded,
  contextFrameworks,
  inScope,
  key,
  normalize,
  reference,
  strings,
  validateRef,
} from './lesson-validation.js';
import { now } from './runtime-status.js';

// The lesson contracts live in lesson-types.ts so lesson-validation.ts can import them without
// referring back to this module. These re-exports keep every established lessons.js import intact.
export type {
  LessonApplicability,
  LessonApprovalSettings,
  LessonDraft,
  LessonEvent,
  LessonEvidence,
  LessonPatch,
  LessonRef,
  LessonRetrieval,
  LessonRetrievalInput,
  LessonScope,
  LessonUse,
  LessonVersion,
} from './lesson-types.js';

/** Local content and version history; effective approval configuration is supplied by the caller. */
export class Lessons {
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS lesson_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL); INSERT OR IGNORE INTO lesson_schema VALUES (1,1);',
    );
    if (Number(db.prepare('SELECT version FROM lesson_schema WHERE id=1').get()?.version) !== 1)
      throw new Error('This database uses a newer or unsupported lesson schema.');
    db.exec(`CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, current_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lesson_versions (lesson_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(lesson_id,version));
      CREATE TABLE IF NOT EXISTS lesson_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lesson_pins (project_id TEXT NOT NULL, lesson_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(project_id,lesson_id));
      CREATE TABLE IF NOT EXISTS lesson_uses (run_id TEXT NOT NULL, agent_id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(run_id,agent_id));`);
  }
  private transaction<T>(action: () => T): T {
    const savepoint = `lesson_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = action();
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }
  private get(ref: LessonRef): LessonVersion {
    validateRef(ref);
    const row = this.db
      .prepare('SELECT document FROM lesson_versions WHERE lesson_id=? AND version=?')
      .get(ref.lessonId, ref.version);
    if (!row) throw new Error('Lesson version does not exist.');
    return JSON.parse(String(row.document)) as LessonVersion;
  }
  private current(ref: LessonRef): LessonVersion {
    const lesson = this.get(ref);
    if (
      Number(
        this.db.prepare('SELECT current_version FROM lessons WHERE id=?').get(ref.lessonId)
          ?.current_version,
      ) !== ref.version
    )
      throw new Error('Lesson version is stale; reload the current lesson.');
    return lesson;
  }
  private put(lesson: LessonVersion): void {
    this.db
      .prepare(
        'INSERT INTO lesson_versions VALUES (?,?,?) ON CONFLICT(lesson_id,version) DO UPDATE SET document=excluded.document',
      )
      .run(lesson.lessonId, lesson.version, JSON.stringify(lesson));
  }
  private event(
    lesson: LessonVersion,
    action: LessonEvent['action'],
    previousStatus?: LessonVersion['status'],
    sourceVersion?: number,
  ): void {
    const event: LessonEvent = {
      reference: reference(lesson),
      action,
      at: now(),
      ...(previousStatus ? { previousStatus } : {}),
      ...(sourceVersion !== undefined ? { sourceVersion } : {}),
      ...(lesson.supersededBy ? { supersededBy: { ...lesson.supersededBy } } : {}),
    };
    this.db
      .prepare('INSERT INTO lesson_events(lesson_id,document) VALUES (?,?)')
      .run(lesson.lessonId, JSON.stringify(event));
  }
  create(input: LessonDraft, settings: LessonApprovalSettings): LessonVersion {
    const body = normalize(input);
    const policy = approvalSettings(settings);
    const automatic =
      body.scope.kind === 'global' ? policy.globalAutoApprove : policy.projectAutoApprove;
    const lesson: LessonVersion = {
      ...body,
      lessonId: randomUUID(),
      version: 1,
      createdAt: now(),
      updatedAt: now(),
      status: automatic ? 'approved' : 'draft',
      approvalSettings: policy,
      ...(automatic ? { approvedBy: 'setting' as const } : {}),
    };
    return this.transaction(() => {
      this.db.prepare('INSERT INTO lessons VALUES (?,1)').run(lesson.lessonId);
      this.put(lesson);
      this.event(lesson, 'created');
      return lesson;
    });
  }
  private revise(
    ref: LessonRef,
    patch: LessonPatch,
    settings: LessonApprovalSettings,
    restoredFrom?: number,
  ): LessonVersion {
    return this.transaction(() => {
      const previous = this.current(ref);
      const body = normalize({ ...previous, ...patch, scope: previous.scope });
      const policy = approvalSettings(settings);
      const automatic =
        body.scope.kind === 'global' ? policy.globalAutoApprove : policy.projectAutoApprove;
      const lesson: LessonVersion = {
        ...body,
        lessonId: ref.lessonId,
        version: ref.version + 1,
        createdAt: now(),
        updatedAt: now(),
        status: automatic ? 'approved' : 'draft',
        approvalSettings: policy,
        ...(automatic ? { approvedBy: 'setting' as const } : {}),
      };
      const previousStatus = previous.status;
      previous.status = 'superseded';
      previous.supersededBy = reference(lesson);
      previous.updatedAt = now();
      this.put(previous);
      this.put(lesson);
      this.db
        .prepare('UPDATE lessons SET current_version=? WHERE id=?')
        .run(lesson.version, lesson.lessonId);
      this.event(
        lesson,
        restoredFrom === undefined ? 'edited' : 'restored',
        previousStatus,
        restoredFrom,
      );
      return lesson;
    });
  }
  edit(ref: LessonRef, patch: LessonPatch, settings: LessonApprovalSettings): LessonVersion {
    return this.revise(ref, patch, settings);
  }
  restore(
    lessonId: string,
    sourceVersion: number,
    expectedCurrentVersion: number,
    settings: LessonApprovalSettings,
  ): LessonVersion {
    const source = this.get({ lessonId, version: sourceVersion });
    return this.revise(
      { lessonId, version: expectedCurrentVersion },
      source,
      settings,
      sourceVersion,
    );
  }
  private decide(refs: LessonRef[], decision: 'approved' | 'rejected'): LessonVersion[] {
    if (
      !Array.isArray(refs) ||
      !refs.length ||
      refs.length > 200 ||
      new Set(refs.map(key)).size !== refs.length
    )
      throw new Error('Choose unique lesson versions for grouped review.');
    return this.transaction(() =>
      refs.map((ref) => {
        const lesson = this.current(ref);
        if (lesson.status === 'superseded')
          throw new Error('Superseded lessons require restoring a new version before approval.');
        const previous = lesson.status;
        lesson.status = decision;
        lesson.updatedAt = now();
        if (decision === 'approved') lesson.approvedBy = 'user';
        this.put(lesson);
        this.event(lesson, decision, previous);
        return lesson;
      }),
    );
  }
  approve(refs: LessonRef[]): LessonVersion[] {
    return this.decide(refs, 'approved');
  }
  reject(refs: LessonRef[]): LessonVersion[] {
    return this.decide(refs, 'rejected');
  }
  supersede(ref: LessonRef, replacement?: LessonRef): LessonVersion {
    return this.transaction(() => {
      const lesson = this.current(ref);
      if (replacement) {
        const next = this.current(replacement);
        if (
          next.lessonId === lesson.lessonId ||
          JSON.stringify(next.scope) !== JSON.stringify(lesson.scope)
        )
          throw new Error('A replacement lesson must be different and have the same scope.');
      }
      const previous = lesson.status;
      lesson.status = 'superseded';
      lesson.updatedAt = now();
      if (replacement) lesson.supersededBy = { ...replacement };
      this.put(lesson);
      this.event(lesson, 'superseded', previous);
      return lesson;
    });
  }
  list(): LessonVersion[] {
    return this.db
      .prepare(
        'SELECT v.document FROM lessons l JOIN lesson_versions v ON v.lesson_id=l.id AND v.version=l.current_version ORDER BY l.rowid',
      )
      .all()
      .map((row) => JSON.parse(String(row.document)) as LessonVersion);
  }
  history(lessonId: string): LessonVersion[] {
    return this.db
      .prepare('SELECT document FROM lesson_versions WHERE lesson_id=? ORDER BY version')
      .all(lessonId)
      .map((row) => JSON.parse(String(row.document)) as LessonVersion);
  }
  events(lessonId: string): LessonEvent[] {
    return this.db
      .prepare('SELECT document FROM lesson_events WHERE lesson_id=? ORDER BY sequence')
      .all(lessonId)
      .map((row) => JSON.parse(String(row.document)) as LessonEvent);
  }
  pins(projectId: string): LessonRef[] {
    return this.db
      .prepare('SELECT lesson_id,version FROM lesson_pins WHERE project_id=? ORDER BY rowid')
      .all(projectId)
      .map((row) => ({ lessonId: String(row.lesson_id), version: Number(row.version) }));
  }
  pin(projectId: string, ref: LessonRef, pinned: boolean): void {
    bounded(projectId, 200, 'project identifier');
    validateRef(ref);
    if (typeof pinned !== 'boolean') throw new Error('Choose whether the lesson should be pinned.');
    if (!pinned) {
      this.db
        .prepare('DELETE FROM lesson_pins WHERE project_id=? AND lesson_id=? AND version=?')
        .run(projectId, ref.lessonId, ref.version);
      return;
    }
    const lesson = this.current(ref);
    if (!inScope(lesson, projectId))
      throw new Error('Lesson does not apply to this project scope.');
    if (lesson.status !== 'approved') throw new Error('Only approved lessons can be pinned.');
    this.db
      .prepare(
        'INSERT INTO lesson_pins VALUES (?,?,?) ON CONFLICT(project_id,lesson_id) DO UPDATE SET version=excluded.version',
      )
      .run(projectId, ref.lessonId, ref.version);
  }
  retrieve(input: LessonRetrievalInput): LessonRetrieval {
    bounded(input.projectId, 200, 'project identifier');
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 0 || limit > 200)
      throw new Error('Lesson result limit must be between 0 and 200.');
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 2000))
      throw new Error('Invalid lesson query.');
    if (input.selected && (!Array.isArray(input.selected) || input.selected.length > 200))
      throw new Error('Too many selected lessons.');
    const tags = strings(input.tags, 32, 'retrieval tags').map((tag) => tag.toLowerCase());
    const frameworks = contextFrameworks(input.frameworks);
    const terms = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const result: LessonRetrieval = {
      lessons: [],
      blockedPins: [],
      blockedSelections: [],
      limitExceeded: false,
    };
    const included = new Set<string>();
    const eligible = (ref: LessonRef): LessonVersion => {
      const lesson = this.current(ref);
      if (!inScope(lesson, input.projectId)) throw new Error('Lesson belongs to another project.');
      if (lesson.status !== 'approved') throw new Error('Lesson version is not approved for use.');
      if (!applicable(lesson, frameworks))
        throw new Error('Lesson framework/version applicability does not match this project.');
      return lesson;
    };
    for (const [refs, reason, blocked] of [
      [this.pins(input.projectId), 'pinned', result.blockedPins],
      [input.selected ?? [], 'selected', result.blockedSelections],
    ] as const) {
      for (const ref of refs) {
        try {
          const lesson = eligible(ref);
          if (!included.has(key(ref))) {
            included.add(key(ref));
            result.lessons.push({ ...lesson, reason });
          }
        } catch (error) {
          blocked.push({
            reference: ref,
            reason: error instanceof Error ? error.message : 'Lesson cannot be supplied.',
          });
        }
      }
    }
    for (const lesson of this.list()) {
      if (result.lessons.length >= limit) break;
      if (
        included.has(key(lesson)) ||
        lesson.status !== 'approved' ||
        !inScope(lesson, input.projectId) ||
        !applicable(lesson, frameworks)
      )
        continue;
      const haystack = `${lesson.title}\n${lesson.text}\n${lesson.tags.join(' ')}`.toLowerCase();
      if (
        !terms.every((term) => haystack.includes(term)) ||
        !tags.every((tag) => lesson.tags.some((value) => value.toLowerCase() === tag))
      )
        continue;
      included.add(key(lesson));
      result.lessons.push({ ...lesson, reason: 'matched' });
    }
    result.limitExceeded = result.lessons.length > limit;
    return result;
  }
  recordUse(input: {
    projectId: string;
    runId: string;
    agentId: string;
    references: LessonRef[];
    frameworks?: Record<string, string>;
  }): LessonUse {
    bounded(input.runId, 200, 'run identifier');
    bounded(input.agentId, 200, 'agent identifier');
    return this.transaction(() => {
      if (this.usage(input.runId, input.agentId))
        throw new Error('Lesson use is already recorded for this run and agent.');
      const selection = this.retrieve({
        projectId: input.projectId,
        selected: input.references,
        frameworks: input.frameworks,
        limit: 0,
      });
      if (selection.blockedPins.length || selection.blockedSelections.length)
        throw new Error(
          'Selected or pinned lesson versions cannot be supplied; resolve the blocked references first.',
        );
      const refs = new Set(input.references.map(key));
      if (selection.lessons.some((lesson) => lesson.reason === 'pinned' && !refs.has(key(lesson))))
        throw new Error('Every pinned lesson must be explicitly supplied.');
      const use: LessonUse = {
        projectId: input.projectId,
        runId: input.runId,
        agentId: input.agentId,
        at: now(),
        frameworks: contextFrameworks(input.frameworks),
        lessons: selection.lessons.map(({ reason: _reason, ...lesson }) => lesson),
      };
      this.db
        .prepare('INSERT INTO lesson_uses VALUES (?,?,?)')
        .run(input.runId, input.agentId, JSON.stringify(use));
      return use;
    });
  }
  usage(runId: string, agentId: string): LessonUse | undefined {
    const row = this.db
      .prepare('SELECT document FROM lesson_uses WHERE run_id=? AND agent_id=?')
      .get(runId, agentId);
    return row ? (JSON.parse(String(row.document)) as LessonUse) : undefined;
  }
}
