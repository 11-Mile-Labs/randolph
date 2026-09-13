import { useEffect, useRef, useState } from 'react';
import type { LessonRef, LessonVersion, MemoryCommand, MemorySnapshot } from '@randolph/runtime/contracts';

const reference = (lesson: LessonVersion): LessonRef => ({ lessonId: lesson.lessonId, version: lesson.version });
const failure = (error: unknown): string => error instanceof Error ? error.message : 'Memory operation failed.';
export default function MemoryPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
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
  const selected = snapshot?.lessons.find(lesson => lesson.lessonId === selectedId);
  const dirty = Boolean(selected && (title !== selected.title || text !== selected.text || tags !== selected.tags.join(', ')));
  const selectedPin = snapshot?.pins.find(pin => pin.lessonId === selectedId);
  const reload = async () => { setSnapshot(await window.randolph.memorySnapshot(projectId)); };
  useEffect(() => {
    dialog.current?.showModal();
    void reload().catch(error => setError(failure(error)));
    return () => dialog.current?.close();
  }, [projectId]);
  const choose = (lesson?: LessonVersion) => {
    setSelectedId(lesson?.lessonId); setTitle(lesson?.title ?? ''); setText(lesson?.text ?? '');
    setTags(lesson?.tags.join(', ') ?? ''); setScope(lesson?.scope.kind ?? 'project'); setHistory([]); setError(undefined);
  };
  const command = async (input: MemoryCommand) => {
    setBusy(true); setError(undefined);
    try { const next = await window.randolph.memoryCommand(input); setSnapshot(next); setChosen([]); return next; }
    catch (error) { setError(failure(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    const body = { title, text, tags: tags.split(',').map(value => value.trim()).filter(Boolean) };
    const next = await command(selected ? { projectId, action: 'edit', reference: reference(selected), patch: body } : { projectId, action: 'create', draft: { ...body, scope: scope === 'global' ? { kind: 'global' } : { kind: 'project', projectId } } });
    if (next) choose(selected ? next.lessons.find(lesson => lesson.lessonId === selected.lessonId) : next.lessons.at(-1));
  };
  const reviewGroup = async (action: 'approve' | 'reject') => {
    const references = snapshot?.lessons.filter(lesson => chosen.includes(lesson.lessonId)).map(reference) ?? [];
    await command({ projectId, action, references });
  };
  return <dialog className="memory-panel" ref={dialog} aria-labelledby="memory-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><span className="eyebrow">Project context</span><h2 id="memory-title">Memory</h2></div><button type="button" className="secondary-button" onClick={onClose}>Close memory</button></header>
    <p>Review lessons before agents use them. Pins retain exact versions; changing a pinned lesson requires updating or removing its pin.</p>
    {(error || snapshot?.projectSettings.error || snapshot?.globalSettings.error) ? <p role="alert" className="inline-error">{error || snapshot?.projectSettings.error || snapshot?.globalSettings.error}</p> : null}
    <div className="memory-layout">
      <aside aria-label="Lessons">
        <button className="primary-button" type="button" onClick={() => choose()}>New lesson</button>
        <div className="memory-group-actions"><button disabled={busy || !chosen.length} onClick={() => void reviewGroup('approve')}>Approve selected</button><button disabled={busy || !chosen.length} onClick={() => void reviewGroup('reject')}>Reject selected</button></div>
        {snapshot?.lessons.map(lesson => <div className={`memory-row ${selectedId === lesson.lessonId ? 'selected' : ''}`} key={lesson.lessonId}>
          <input aria-label={`Select ${lesson.title}`} type="checkbox" checked={chosen.includes(lesson.lessonId)} onChange={event => setChosen(values => event.target.checked ? [...values, lesson.lessonId] : values.filter(id => id !== lesson.lessonId))} />
          <button type="button" onClick={() => choose(lesson)}><strong>{lesson.title}</strong><small>{lesson.scope.kind} · v{lesson.version} · {lesson.status}{snapshot.pins.some(pin => pin.lessonId === lesson.lessonId) ? ' · pinned' : ''}</small></button>
        </div>)}
        {!snapshot?.lessons.length ? <p className="muted">No lessons yet.</p> : null}
      </aside>
      <section className="memory-editor" aria-label="Lesson editor">
        <label>Scope<select aria-label="Lesson scope" value={scope} disabled={Boolean(selected) || busy} onChange={event => setScope(event.target.value as 'project' | 'global')}><option value="project">This project</option><option value="global">Global, when relevant</option></select></label>
        <label>Title<input aria-label="Lesson title" maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>Lesson<textarea aria-label="Lesson text" rows={7} maxLength={16000} value={text} onChange={event => setText(event.target.value)} /></label>
        <label>Tags<input aria-label="Lesson tags" value={tags} onChange={event => setTags(event.target.value)} placeholder="testing, migrations" /></label>
        <div className="memory-actions"><button className="primary-button" disabled={busy || !title.trim() || !text.trim()} onClick={() => void save()}>{selected ? 'Save new version' : 'Create lesson'}</button>
          {dirty ? <p>Save edits as a new version before approving them.</p> : null}
        {selected ? <><button className="secondary-button" disabled={busy || dirty || selected.status === 'superseded'} onClick={() => void command({ projectId, action: 'approve', references: [reference(selected)] })}>Approve lesson</button><button className="secondary-button" disabled={busy} onClick={() => void command({ projectId, action: 'reject', references: [reference(selected)] })}>Reject lesson</button></> : null}
        </div>
        {dirty ? <p>Save edits as a new version before approving them.</p> : null}
        {selected ? <>
          <div className="memory-actions"><button className="secondary-button" disabled={busy || (!selectedPin && selected.status !== 'approved')} onClick={() => void command({ projectId, action: 'pin', reference: selectedPin ?? reference(selected), pinned: !selectedPin })}>{selectedPin ? `Remove pin v${selectedPin.version}` : 'Pin this version'}</button>
            {selectedPin && selectedPin.version !== selected.version && selected.status === 'approved' ? <button className="secondary-button" disabled={busy} onClick={() => void command({ projectId, action: 'pin', reference: reference(selected), pinned: true })}>Update pin to v{selected.version}</button> : null}
            <button className="secondary-button" onClick={() => { void (async () => { try { setHistory(await window.randolph.memoryHistory(projectId, reference(selected))); } catch (error) { setError(failure(error)); } })(); }}>Version history</button>
          </div>
          {selectedPin && selectedPin.version !== selected.version ? <p className="inline-error">The pin still refers to v{selectedPin.version}. New messages are blocked until that pin is resolved.</p> : null}
          {selected.evidence.length ? <details><summary>Supporting evidence</summary>{selected.evidence.map((item, i) => <p key={i}>{item.label}: <code>{item.uri}</code></p>)}</details> : null}
          {history.map(version => <details key={version.version}><summary>Version {version.version} · {version.status}</summary><p>{version.text}</p><button className="secondary-button" disabled={busy} onClick={() => void command({ projectId, action: 'restore', reference: reference(selected), sourceVersion: version.version })}>Restore version {version.version}</button></details>)}
        </> : null}
      </section>
    </div>
    {snapshot ? <details className="memory-preferences"><summary>Approval preferences and framework versions</summary>
      <p>Project and global auto-approval are separate. Changes apply to newly created or edited lessons.</p>
      <ProjectPreferences key={snapshot.projectSettings.revision ?? 'default'} settings={snapshot.projectSettings} busy={busy} save={value => command({ projectId, action: 'settings', scope: 'project', value, expectedRevision: snapshot.projectSettings.revision })} />
      <label><input type="checkbox" checked={snapshot.globalSettings.value.autoApprove} disabled={busy} onChange={event => void command({ projectId, action: 'settings', scope: 'global', value: { ...snapshot.globalSettings.value, autoApprove: event.target.checked }, expectedRevision: snapshot.globalSettings.revision })} />Automatically approve new global lessons</label>

    </details> : null}
    <footer><button className="secondary-button" disabled={busy} onClick={() => { void reload().catch(error => setError(failure(error))); }}>Reload memory</button></footer>
  </dialog>;
}

function ProjectPreferences({ settings, busy, save }: { settings: MemorySnapshot['projectSettings']; busy: boolean; save: (value: MemorySnapshot['projectSettings']['value']) => Promise<unknown> }) {
  const [autoApprove, setAutoApprove] = useState(settings.value.autoApprove);
  const [frameworks, setFrameworks] = useState(Object.entries(settings.value.frameworks).map(([name, version]) => `${name}=${version}`).join('\n'));
  const [error, setError] = useState<string>();
  const submit = async () => {
    try {
      const entries = frameworks.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const separator = line.indexOf('=');
        if (separator < 1 || !line.slice(separator + 1).trim()) throw new Error('Use one Framework=Version pair per line.');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
      });
      if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error('Framework names must be unique.');
      setError(undefined); await save({ autoApprove, frameworks: Object.fromEntries(entries) });
    } catch (error) { setError(failure(error)); }
  };
  return <div className="memory-project-preferences">
    <label><input type="checkbox" checked={autoApprove} disabled={busy} onChange={event => setAutoApprove(event.target.checked)} />Automatically approve new project lessons</label>
    <label>Project framework versions<textarea aria-label="Project framework versions" rows={3} value={frameworks} onChange={event => setFrameworks(event.target.value)} placeholder="React=19" /></label>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <button className="secondary-button" disabled={busy} onClick={() => void submit()}>Save project memory preferences</button>
  </div>;
}
