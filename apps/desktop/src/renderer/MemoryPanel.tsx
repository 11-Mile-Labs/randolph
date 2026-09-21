import { useEffect, useRef, useState } from 'react';
import type {
  LessonRef,
  LessonVersion,
  MemoryCommand,
  MemorySnapshot,
} from '@randolph/runtime/contracts';
import MemoryLessonEditor from './MemoryLessonEditor';
import MemoryLessonList from './MemoryLessonList';
import MemoryPreferencesSection from './MemoryPreferencesSection';
import { failure } from './memory-panel-types';

export { failure } from './memory-panel-types';

const reference = (lesson: LessonVersion): LessonRef => ({
  lessonId: lesson.lessonId,
  version: lesson.version,
});
export default function MemoryPanel({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [chosen, setChosen] = useState<string[]>([]);
  const [history, setHistory] = useState<LessonVersion[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const selected = snapshot?.lessons.find((lesson) => lesson.lessonId === selectedId);
  const dirty = Boolean(
    selected &&
    (title !== selected.title || text !== selected.text || tags !== selected.tags.join(', ')),
  );
  const selectedPin = snapshot?.pins.find((pin) => pin.lessonId === selectedId);
  const reload = async () => {
    setSnapshot(await window.randolph.memorySnapshot(projectId));
  };
  useEffect(() => {
    dialog.current?.showModal();
    void reload().catch((error) => setError(failure(error)));
    return () => dialog.current?.close();
  }, [projectId]);
  const choose = (lesson?: LessonVersion) => {
    setSelectedId(lesson?.lessonId);
    setTitle(lesson?.title ?? '');
    setText(lesson?.text ?? '');
    setTags(lesson?.tags.join(', ') ?? '');
    setScope(lesson?.scope.kind ?? 'project');
    setHistory([]);
    setError(undefined);
  };
  const command = async (input: MemoryCommand) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.randolph.memoryCommand(input);
      setSnapshot(next);
      setChosen([]);
      return next;
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const body = {
      title,
      text,
      tags: tags
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    };
    const next = await command(
      selected
        ? { projectId, action: 'edit', reference: reference(selected), patch: body }
        : {
            projectId,
            action: 'create',
            draft: {
              ...body,
              scope: scope === 'global' ? { kind: 'global' } : { kind: 'project', projectId },
            },
          },
    );
    if (next)
      choose(
        selected
          ? next.lessons.find((lesson) => lesson.lessonId === selected.lessonId)
          : next.lessons.at(-1),
      );
  };
  const reviewGroup = async (action: 'approve' | 'reject') => {
    const references =
      snapshot?.lessons.filter((lesson) => chosen.includes(lesson.lessonId)).map(reference) ?? [];
    await command({ projectId, action, references });
  };
  const toggleChosen = (lessonId: string, checked: boolean) => {
    setChosen((values) =>
      checked ? [...values, lessonId] : values.filter((id) => id !== lessonId),
    );
  };
  const approveSelected = () => {
    if (!selected) return;
    void command({ projectId, action: 'approve', references: [reference(selected)] });
  };
  const rejectSelected = () => {
    if (!selected) return;
    void command({ projectId, action: 'reject', references: [reference(selected)] });
  };
  const togglePin = () => {
    if (!selected) return;
    void command({
      projectId,
      action: 'pin',
      reference: selectedPin ?? reference(selected),
      pinned: !selectedPin,
    });
  };
  const updatePin = () => {
    if (!selected) return;
    void command({ projectId, action: 'pin', reference: reference(selected), pinned: true });
  };
  const restoreVersion = (sourceVersion: number) => {
    if (!selected) return;
    void command({
      projectId,
      action: 'restore',
      reference: reference(selected),
      sourceVersion,
    });
  };
  const loadHistory = () => {
    if (!selected) return;
    void (async () => {
      try {
        setHistory(await window.randolph.memoryHistory(projectId, reference(selected)));
      } catch (error) {
        setError(failure(error));
      }
    })();
  };
  return (
    <dialog
      className="memory-panel"
      ref={dialog}
      aria-labelledby="memory-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">Project context</span>
          <h2 id="memory-title">Memory</h2>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>
          Close memory
        </button>
      </header>
      <p>
        Review lessons before agents use them. Pins retain exact versions; changing a pinned lesson
        requires updating or removing its pin.
      </p>
      {error || snapshot?.projectSettings.error || snapshot?.globalSettings.error ? (
        <p role="alert" className="inline-error">
          {error || snapshot?.projectSettings.error || snapshot?.globalSettings.error}
        </p>
      ) : null}
      <div className="memory-layout">
        <MemoryLessonList
          lessons={snapshot?.lessons ?? []}
          pins={snapshot?.pins ?? []}
          selectedId={selectedId}
          chosen={chosen}
          busy={busy}
          onChoose={choose}
          onReviewGroup={reviewGroup}
          onToggleChosen={toggleChosen}
        />
        <MemoryLessonEditor
          scope={scope}
          title={title}
          text={text}
          tags={tags}
          selected={selected}
          selectedPin={selectedPin}
          history={history}
          dirty={dirty}
          busy={busy}
          onScopeChange={setScope}
          onTitleChange={setTitle}
          onTextChange={setText}
          onTagsChange={setTags}
          onSave={save}
          onApprove={approveSelected}
          onReject={rejectSelected}
          onTogglePin={togglePin}
          onUpdatePin={updatePin}
          onHistory={loadHistory}
          onRestore={restoreVersion}
        />
      </div>
      {snapshot ? (
        <MemoryPreferencesSection
          projectSettings={snapshot.projectSettings}
          globalAutoApprove={snapshot.globalSettings.value.autoApprove}
          busy={busy}
          onSaveProject={(value) =>
            command({
              projectId,
              action: 'settings',
              scope: 'project',
              value,
              expectedRevision: snapshot.projectSettings.revision,
            })
          }
          onSaveGlobal={(autoApprove) =>
            void command({
              projectId,
              action: 'settings',
              scope: 'global',
              value: { ...snapshot.globalSettings.value, autoApprove },
              expectedRevision: snapshot.globalSettings.revision,
            })
          }
        />
      ) : null}
      <footer>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            void reload().catch((error) => setError(failure(error)));
          }}
        >
          Reload memory
        </button>
      </footer>
    </dialog>
  );
}
