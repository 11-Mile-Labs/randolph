import type { LessonRef, LessonVersion } from '@randolph/runtime/contracts';

type Props = {
  scope: 'project' | 'global';
  title: string;
  text: string;
  tags: string;
  selected?: LessonVersion;
  selectedPin?: LessonRef;
  history: LessonVersion[];
  dirty: boolean;
  busy: boolean;
  onScopeChange: (scope: 'project' | 'global') => void;
  onTitleChange: (title: string) => void;
  onTextChange: (text: string) => void;
  onTagsChange: (tags: string) => void;
  onSave: () => Promise<void>;
  onApprove: () => void;
  onReject: () => void;
  onTogglePin: () => void;
  onUpdatePin: () => void;
  onHistory: () => void;
  onRestore: (sourceVersion: number) => void;
};

export default function MemoryLessonEditor({
  scope,
  title,
  text,
  tags,
  selected,
  selectedPin,
  history,
  dirty,
  busy,
  onScopeChange,
  onTitleChange,
  onTextChange,
  onTagsChange,
  onSave,
  onApprove,
  onReject,
  onTogglePin,
  onUpdatePin,
  onHistory,
  onRestore,
}: Props) {
  return (
    <section className="memory-editor" aria-label="Lesson editor">
      <label>
        Scope
        <select
          aria-label="Lesson scope"
          value={scope}
          disabled={Boolean(selected) || busy}
          onChange={(event) => onScopeChange(event.target.value as 'project' | 'global')}
        >
          <option value="project">This project</option>
          <option value="global">Global, when relevant</option>
        </select>
      </label>
      <label>
        Title
        <input
          aria-label="Lesson title"
          maxLength={200}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
        />
      </label>
      <label>
        Lesson
        <textarea
          aria-label="Lesson text"
          rows={7}
          maxLength={16000}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
        />
      </label>
      <label>
        Tags
        <input
          aria-label="Lesson tags"
          value={tags}
          onChange={(event) => onTagsChange(event.target.value)}
          placeholder="testing, migrations"
        />
      </label>
      <div className="memory-actions">
        <button
          className="primary-button"
          disabled={busy || !title.trim() || !text.trim()}
          onClick={() => void onSave()}
        >
          {selected ? 'Save new version' : 'Create lesson'}
        </button>
        {dirty ? <p>Save edits as a new version before approving them.</p> : null}
        {selected ? (
          <>
            <button
              className="secondary-button"
              disabled={busy || dirty || selected.status === 'superseded'}
              onClick={onApprove}
            >
              Approve lesson
            </button>
            <button className="secondary-button" disabled={busy} onClick={onReject}>
              Reject lesson
            </button>
          </>
        ) : null}
      </div>
      {dirty ? <p>Save edits as a new version before approving them.</p> : null}
      {selected ? (
        <>
          <div className="memory-actions">
            <button
              className="secondary-button"
              disabled={busy || (!selectedPin && selected.status !== 'approved')}
              onClick={onTogglePin}
            >
              {selectedPin ? `Remove pin v${selectedPin.version}` : 'Pin this version'}
            </button>
            {selectedPin &&
            selectedPin.version !== selected.version &&
            selected.status === 'approved' ? (
              <button className="secondary-button" disabled={busy} onClick={onUpdatePin}>
                Update pin to v{selected.version}
              </button>
            ) : null}
            <button className="secondary-button" onClick={onHistory}>
              Version history
            </button>
          </div>
          {selectedPin && selectedPin.version !== selected.version ? (
            <p className="inline-error">
              The pin still refers to v{selectedPin.version}. New messages are blocked until that
              pin is resolved.
            </p>
          ) : null}
          {selected.evidence.length ? (
            <details>
              <summary>Supporting evidence</summary>
              {selected.evidence.map((item, i) => (
                <p key={i}>
                  {item.label}: <code>{item.uri}</code>
                </p>
              ))}
            </details>
          ) : null}
          {history.map((version) => (
            <details key={version.version}>
              <summary>
                Version {version.version} · {version.status}
              </summary>
              <p>{version.text}</p>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => onRestore(version.version)}
              >
                Restore version {version.version}
              </button>
            </details>
          ))}
        </>
      ) : null}
    </section>
  );
}
