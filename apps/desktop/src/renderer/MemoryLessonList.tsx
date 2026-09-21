import type { LessonRef, LessonVersion } from '@randolph/runtime/contracts';

type Props = {
  lessons: LessonVersion[];
  pins: LessonRef[];
  selectedId?: string;
  chosen: string[];
  busy: boolean;
  onChoose: (lesson?: LessonVersion) => void;
  onReviewGroup: (action: 'approve' | 'reject') => Promise<void>;
  onToggleChosen: (lessonId: string, chosen: boolean) => void;
};

export default function MemoryLessonList({
  lessons,
  pins,
  selectedId,
  chosen,
  busy,
  onChoose,
  onReviewGroup,
  onToggleChosen,
}: Props) {
  return (
    <aside aria-label="Lessons">
      <button className="primary-button" type="button" onClick={() => onChoose()}>
        New lesson
      </button>
      <div className="memory-group-actions">
        <button disabled={busy || !chosen.length} onClick={() => void onReviewGroup('approve')}>
          Approve selected
        </button>
        <button disabled={busy || !chosen.length} onClick={() => void onReviewGroup('reject')}>
          Reject selected
        </button>
      </div>
      {lessons.map((lesson) => (
        <div
          className={`memory-row ${selectedId === lesson.lessonId ? 'selected' : ''}`}
          key={lesson.lessonId}
        >
          <input
            aria-label={`Select ${lesson.title}`}
            type="checkbox"
            checked={chosen.includes(lesson.lessonId)}
            onChange={(event) => onToggleChosen(lesson.lessonId, event.target.checked)}
          />
          <button type="button" onClick={() => onChoose(lesson)}>
            <strong>{lesson.title}</strong>
            <small>
              {lesson.scope.kind} · v{lesson.version} · {lesson.status}
              {pins.some((pin) => pin.lessonId === lesson.lessonId) ? ' · pinned' : ''}
            </small>
          </button>
        </div>
      ))}
      {!lessons.length ? <p className="muted">No lessons yet.</p> : null}
    </aside>
  );
}
