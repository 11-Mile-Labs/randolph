import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  Conversation,
  HarnessInfo,
  HarnessModel,
  Message,
  Project,
  Run,
  RunEvent,
  WorkspaceSnapshot,
} from '@randolph/runtime/contracts';

const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  projects: [],
  conversations: [],
  runs: [],
  messages: [],
  events: [],
  dataRoot: '',
};

const BLOCKING_STATUSES = new Set<Run['status']>(['starting', 'running', 'stopping', 'stop-unconfirmed']);
const NATIVE_EVENT_TYPES = new Set(['activity', 'session.started', 'message.delta', 'approval.denied']);

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function relativeTime(value: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  if (elapsed < 5_000) return 'just now';
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function latestSequence(events: RunEvent[], conversationId: string): number {
  let latest = 0;
  for (const event of events) {
    if (event.conversationId === conversationId) latest = Math.max(latest, event.sequence);
  }
  return latest;
}

function unreadCount(events: RunEvent[], conversation: Conversation): number {
  let count = 0;
  for (const event of events) {
    if (event.conversationId === conversation.id && event.sequence > conversation.lastReadSequence) count += 1;
  }
  return count;
}

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      R
    </span>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="5" y="5" width="10" height="10" rx="1.5" />
    </svg>
  );
}

type SidebarProps = {
  projects: Project[];
  conversations: Conversation[];
  events: RunEvent[];
  selectedConversationId?: string;
  busy: boolean;
  onAddProject: () => void;
  onCreateConversation: (projectId: string) => void;
  onSelectConversation: (conversationId: string) => void;
};

function Sidebar({
  projects,
  conversations,
  events,
  selectedConversationId,
  busy,
  onAddProject,
  onCreateConversation,
  onSelectConversation,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Projects and conversations">
      <div className="brand-row">
        <LogoMark />
        <div>
          <strong>Randolph</strong>
          <span>Project workspace</span>
        </div>
      </div>

      <button className="add-project-button" type="button" onClick={onAddProject} disabled={busy}>
        <PlusIcon />
        Add project
      </button>

      <nav className="project-list" aria-label="Project conversations">
        {projects.length === 0 ? (
          <p className="sidebar-empty">Add a project to begin a conversation.</p>
        ) : (
          projects.map((project) => {
            const projectConversations = conversations
              .filter((conversation) => conversation.projectId === project.id)
              .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return (
              <section className="project-group" key={project.id}>
                <div className="project-heading">
                  <div>
                    <strong title={project.root}>{project.name}</strong>
                    <span>{project.root}</span>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`New conversation in ${project.name}`}
                    title="New conversation"
                    onClick={() => onCreateConversation(project.id)}
                    disabled={busy}
                  >
                    <PlusIcon />
                  </button>
                </div>
                <div className="conversation-list">
                  {projectConversations.length === 0 ? (
                    <button
                      className="new-conversation-prompt"
                      type="button"
                      onClick={() => onCreateConversation(project.id)}
                      disabled={busy}
                    >
                      Start a conversation
                    </button>
                  ) : (
                    projectConversations.map((conversation) => {
                      const unread = unreadCount(events, conversation);
                      return (
                        <button
                          className={`conversation-button${selectedConversationId === conversation.id ? ' selected' : ''}`}
                          type="button"
                          key={conversation.id}
                          onClick={() => onSelectConversation(conversation.id)}
                          aria-current={selectedConversationId === conversation.id ? 'page' : undefined}
                        >
                          <span>{conversation.title}</span>
                          {unread > 0 ? (
                            <span className="unread-badge" aria-label={`${unread} unread events`}>
                              {unread > 99 ? '99+' : unread}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })
        )}
      </nav>
    </aside>
  );
}

type ActivityPanelProps = {
  run?: Run;
  events: RunEvent[];
  dataRoot: string;
  now: number;
  stopping: boolean;
  onStop: (runId: string) => void;
};

function ActivityPanel({ run, events, dataRoot, now, stopping, onStop }: ActivityPanelProps) {
  const lastNativeEvent = events.findLast((event) => NATIVE_EVENT_TYPES.has(event.type));
  const canStop = run ? run.status === 'starting' || run.status === 'running' : false;
  const lastResponse = events.findLast(event => event.type === 'message.delta');
  const visibleEvents = events.filter(event => event.type.startsWith('run.') || event.type === 'session.started' || event.type === 'approval.denied' || event.sequence === lastResponse?.sequence || (event.data.method === 'item/started' && event.data.itemType === 'commandExecution')).slice(-12);


  return (
    <aside className="activity-panel" aria-label="Live activity">
      <div className="activity-heading">
        <div>
          <span className="eyebrow">Current run</span>
          <h2>Live activity</h2>
        </div>
        {run ? <span className={`status-dot ${run.status}`} aria-hidden="true" /> : null}
      </div>

      {!run ? (
        <div className="activity-empty">
          <span className="quiet-pulse" aria-hidden="true" />
          <strong>No active run</strong>
          <p>Native activity will appear here after you send a message.</p>
        </div>
      ) : (
        <>
          <div className="status-card">
            <div className="status-row">
              <span>Status</span>
              <strong>{run.status.replace('-', ' ')}</strong>
            </div>
            <div className="status-row">
              <span>Last native event</span>
              <strong>{lastNativeEvent ? relativeTime(lastNativeEvent.at, now) : 'None recorded'}</strong>
            </div>
            <div className="status-row">
              <span>Model</span>
              <strong>{run.model}</strong>
            </div>
          </div>

          {run.error ? (
            <div className="inline-error" role="alert">
              {run.error}
            </div>
          ) : null}

          <button
            className="stop-button"
            type="button"
            disabled={!canStop || stopping}
            onClick={() => onStop(run.id)}
          >
            <StopIcon />
            {stopping || run.status === 'stopping' ? 'Stopping…' : 'Stop run'}
          </button>

          <div className="event-list" aria-label="Run events">
            {events.length === 0 ? (
              <p className="muted-copy">Waiting for the first native event.</p>
            ) : (
              visibleEvents
                .toReversed()
                .map((event) => (
                  <details className="event-item" key={`${event.runId}-${event.sequence}`}>
                    <summary>
                      <span className="event-line" aria-hidden="true" />
                      <span>
                        <strong>{event.summary}</strong>
                        <small>{formatTime(event.at)}</small>
                      </span>
                    </summary>
                    <div className="event-detail">
                      <code>{event.type}</code>
                      {Object.keys(event.data).length > 0 ? (
                        <pre>{JSON.stringify(event.data, null, 2)}</pre>
                      ) : (
                        <p>No additional details.</p>
                      )}
                    </div>
                  </details>
                ))
            )}
          </div>
          <details className="native-records">
            <summary>All {events.length} recorded events</summary>
            <pre>{events.map(event => `${event.at} ${event.type} ${event.summary} ${JSON.stringify(event.data)}`).join("\n")}</pre>
          </details>
        </>
      )}

      <details className="storage-detail">
        <summary>Stored run data</summary>
        <p>{run?.logsPath ? 'Durable logs for this run:' : 'Randolph data root:'}</p>
        <code>{run?.logsPath || dataRoot || 'Data path unavailable'}</code>
        {run ? <p className="run-identifier">Run ID: {run.id}</p> : null}
      </details>
    </aside>
  );
}

type WelcomeProps = {
  hasProjects: boolean;
  busy: boolean;
  harness?: HarnessInfo;
  onAddProject: () => void;
};

function Welcome({ hasProjects, busy, harness, onAddProject }: WelcomeProps) {
  const harnessReady = Boolean(harness?.available && harness.authenticated && harness.models.length > 0);
  return (
    <div className="welcome">
      <LogoMark />
      <span className="eyebrow">Read-only workspace</span>
      <h1>{hasProjects ? 'Choose a conversation' : 'Bring a project into focus'}</h1>
      <p>
        {hasProjects
          ? 'Select a conversation from the sidebar, or start a new one inside a project.'
          : 'Add a local project to inspect it, ask questions, and follow native activity as it happens.'}
      </p>
      {!hasProjects ? (
        <button className="primary-button" type="button" onClick={onAddProject} disabled={busy}>
          <PlusIcon />
          Add your first project
        </button>
      ) : null}
      <span className={`harness-readiness${harnessReady ? ' ready' : ''}`} role="status">
        <span aria-hidden="true" />
        {!harness ? 'Checking native harness…' : harnessReady ? 'Native harness ready' : 'Native harness unavailable'}
      </span>
      <small>Project modification and final delivery are not available in this slice.</small>
    </div>
  );
}

type ComposerProps = {
  harness?: HarnessInfo;
  model: string;
  effort: string;
  value: string;
  disabled: boolean;
  sending: boolean;
  onModelChange: (model: HarnessModel) => void;
  onEffortChange: (effort: string) => void;
  onValueChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function Composer({
  harness,
  model,
  effort,
  value,
  disabled,
  sending,
  onModelChange,
  onEffortChange,
  onValueChange,
  onSubmit,
}: ComposerProps) {
  const selectedModel = harness?.models.find((item) => item.id === model);
  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        aria-label="Message"
        placeholder="Ask Randolph about this project…"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={disabled}
        rows={2}
      />
      <div className="composer-toolbar">
        <div className="selector-group">
          <label>
            <span className="sr-only">Model</span>
            <select
              value={model}
              disabled={disabled || !harness?.available}
              onChange={(event) => {
                const next = harness?.models.find((item) => item.id === event.target.value);
                if (next) onModelChange(next);
              }}
            >
              {harness?.models.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Reasoning effort</span>
            <select
              value={effort}
              disabled={disabled || !selectedModel}
              onChange={(event) => onEffortChange(event.target.value)}
            >
              {selectedModel?.efforts.map((item) => (
                <option value={item} key={item}>
                  {item} effort
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          className="send-button"
          type="submit"
          aria-label="Send message"
          disabled={disabled || sending || value.trim().length === 0 || !model || !effort}
        >
          {sending ? (
            <span className="button-spinner" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 10 5-5 5 5M10 5v10" />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}

function MessageBubble({ message }: { message: Message }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.role === 'assistant' ? 'R' : 'You'}
      </div>
      <div>
        <header>
          <strong>{message.role === 'assistant' ? 'Randolph' : 'You'}</strong>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </header>
        <p>{message.text}</p>
      </div>
    </article>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [harness, setHarness] = useState<HarnessInfo>();
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modelChoices, setModelChoices] = useState<Record<string, { model: string; effort: string }>>({});
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'project' | 'conversation' | 'send' | 'stop'>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const loadVersion = useRef(0);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const nearMessageEnd = useRef(true);

  const reloadSnapshot = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const next = await window.randolph.snapshot();
      if (version === loadVersion.current) setSnapshot(next);
    } catch (loadError) {
      if (version === loadVersion.current) setError(`Could not load workspace: ${displayError(loadError)}`);
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadSnapshot();
    let disposed = false;
    const loadHarness = async (): Promise<void> => {
      try {
        const info = await window.randolph.harness();
        if (!disposed) setHarness(info);
      } catch (harnessError) {
        if (!disposed) setError(`Could not inspect the native harness: ${displayError(harnessError)}`);
      }
    };
    void loadHarness();
    const unsubscribe = window.randolph.onChanged(() => void reloadSnapshot());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [reloadSnapshot]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedConversation = snapshot.conversations.find((item) => item.id === selectedConversationId);
  const selectedProject = selectedConversation
    ? snapshot.projects.find((item) => item.id === selectedConversation.projectId)
    : undefined;

  useEffect(() => {
    if (!selectedConversation) return;
    setModelChoices((current) => {
      const existing = current[selectedConversation.id];
      const existingModel = harness?.models.find((item) => item.id === existing?.model);
      if (existing && existingModel?.efforts.includes(existing.effort)) return current;
      const conversationModel = harness?.models.find((item) => item.id === selectedConversation.model);
      const fallbackModel = conversationModel ?? harness?.models[0];
      const next = {
        model: fallbackModel?.id ?? selectedConversation.model,
        effort: fallbackModel?.efforts.includes(selectedConversation.effort)
          ? selectedConversation.effort
          : (fallbackModel?.defaultEffort ?? selectedConversation.effort),
      };
      if (existing?.model === next.model && existing.effort === next.effort) return current;
      return { ...current, [selectedConversation.id]: next };
    });
  }, [harness, selectedConversation?.effort, selectedConversation?.id, selectedConversation?.model]);

  const conversationEvents = useMemo(
    () =>
      snapshot.events
        .filter((event) => event.conversationId === selectedConversationId)
        .toSorted((a, b) => a.sequence - b.sequence),
    [selectedConversationId, snapshot.events],
  );
  const conversationRuns = useMemo(
    () =>
      snapshot.runs
        .filter((run) => run.conversationId === selectedConversationId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [selectedConversationId, snapshot.runs],
  );
  const latestRun = conversationRuns[0];
  const runEvents = latestRun ? conversationEvents.filter((event) => event.runId === latestRun.id) : [];
  const messages = snapshot.messages
    .filter((message) => message.conversationId === selectedConversationId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const selectedDraft = selectedConversationId ? (drafts[selectedConversationId] ?? '') : '';
  const selectedModelChoice = selectedConversationId
    ? modelChoices[selectedConversationId] ?? { model: '', effort: '' }
    : { model: '', effort: '' };
  const lastMessage = messages.at(-1);
  const lastMessageKey = lastMessage ? `${lastMessage.id}:${lastMessage.text.length}` : selectedConversationId;

  useEffect(() => {
    if (!nearMessageEnd.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = messageScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [lastMessageKey, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversation) return;
    const newest = latestSequence(snapshot.events, selectedConversation.id);
    if (newest <= selectedConversation.lastReadSequence) return;
    let disposed = false;
    const markRead = async (): Promise<void> => {
      try {
        await window.randolph.markRead(selectedConversation.id);
      } catch (markError) {
        if (!disposed) setError(`Could not mark the conversation as read: ${displayError(markError)}`);
      }
    };
    void markRead();
    return () => {
      disposed = true;
    };
  }, [selectedConversation, snapshot.events]);

  const selectConversation = (conversationId: string) => {
    nearMessageEnd.current = true;
    setSelectedConversationId(conversationId);
    setError(undefined);
  };

  const addProject = async () => {
    setAction('project');
    setError(undefined);
    try {
      const project = await window.randolph.addProject();
      if (!project) return;
      const conversation = await window.randolph.createConversation(project.id);
      setSelectedConversationId(conversation.id);
      await reloadSnapshot();
    } catch (addError) {
      setError(`Could not add the project: ${displayError(addError)}`);
    } finally {
      setAction(undefined);
    }
  };

  const createConversation = async (projectId: string) => {
    setAction('conversation');
    setError(undefined);
    try {
      const conversation = await window.randolph.createConversation(projectId);
      setSelectedConversationId(conversation.id);
      await reloadSnapshot();
    } catch (createError) {
      setError(`Could not create the conversation: ${displayError(createError)}`);
    } finally {
      setAction(undefined);
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const conversationId = selectedConversation?.id;
    const text = selectedDraft.trim();
    const { model, effort } = selectedModelChoice;
    if (!conversationId || !text || !model || !effort) return;
    setAction('send');
    setError(undefined);
    try {
      await window.randolph.send({ conversationId, text, model, effort });
      setDrafts((current) =>
        current[conversationId]?.trim() === text ? { ...current, [conversationId]: '' } : current,
      );
      await reloadSnapshot();
    } catch (sendError) {
      setError(`Message was not sent: ${displayError(sendError)}`);
    } finally {
      setAction(undefined);
    }
  };

  const stopRun = async (runId: string) => {
    setAction('stop');
    setError(undefined);
    try {
      await window.randolph.stop(runId);
      await reloadSnapshot();
    } catch (stopError) {
      setError(`Could not stop the run: ${displayError(stopError)}`);
    } finally {
      setAction(undefined);
    }
  };

  const activeRun = latestRun && BLOCKING_STATUSES.has(latestRun.status);
  const composerDisabled =
    Boolean(activeRun) || !harness?.available || !harness.authenticated || harness.models.length === 0;
  const harnessReason = harness
    ? !harness.available || !harness.authenticated
      ? (harness.reason ?? 'Authentication or availability could not be confirmed.')
      : harness.models.length === 0
        ? 'No models were reported by the native harness.'
        : undefined
    : undefined;

  return (
    <div className="app-shell">
      <Sidebar
        projects={snapshot.projects}
        conversations={snapshot.conversations}
        events={snapshot.events}
        selectedConversationId={selectedConversationId}
        busy={action === 'project' || action === 'conversation'}
        onAddProject={() => void addProject()}
        onCreateConversation={(projectId) => void createConversation(projectId)}
        onSelectConversation={selectConversation}
      />

      <main className="workspace">
        {loading ? (
          <div className="loading-state" role="status">
            <span className="button-spinner" aria-hidden="true" />
            Opening workspace…
          </div>
        ) : !selectedConversation ? (
          <Welcome
            hasProjects={snapshot.projects.length > 0}
            busy={action === 'project'}
            harness={harness}
            onAddProject={() => void addProject()}
          />
        ) : (
          <>
            <header className="conversation-header">
              <div>
                <span className="eyebrow">Read-only workspace</span>
                <h1>{selectedConversation.title}</h1>
                <p>{selectedProject?.name}{latestRun && latestRun.workspace !== selectedProject?.root ? " · Committed snapshot" : ""}</p>
              </div>
              {harness?.version ? <span className="version-chip">Codex {harness.version}</span> : null}
            </header>

            <div
              className="message-scroll"
              aria-live="polite"
              ref={messageScrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                nearMessageEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
              }}
            >
              {messages.length === 0 ? (
                <div className="conversation-empty">
                  <LogoMark />
                  <h2>What should Randolph inspect?</h2>
                  <p>Ask a question about the project. Native events will be recorded alongside the response.</p>
                </div>
              ) : (
                <div className="message-column">
                  {messages.map((message) => (
                    <MessageBubble message={message} key={message.id} />
                  ))}
                </div>
              )}
            </div>

            <div className="composer-area">
              {error ? (
                <div className="composer-error" role="alert">
                  <strong>Randolph hit a snag.</strong>
                  <span>{error}</span>
                  <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">
                    ×
                  </button>
                </div>
              ) : null}
              {harnessReason ? <p className="harness-warning">Native harness unavailable: {harnessReason}</p> : null}
              <Composer
                harness={harness}
                model={selectedModelChoice.model}
                effort={selectedModelChoice.effort}
                value={selectedDraft}
                disabled={composerDisabled}
                sending={action === 'send'}
                onModelChange={(nextModel) => {
                  if (!selectedConversationId) return;
                  setModelChoices((current) => ({
                    ...current,
                    [selectedConversationId]: { model: nextModel.id, effort: nextModel.defaultEffort },
                  }));
                }}
                onEffortChange={(nextEffort) => {
                  if (!selectedConversationId) return;
                  setModelChoices((current) => ({
                    ...current,
                    [selectedConversationId]: { ...selectedModelChoice, effort: nextEffort },
                  }));
                }}
                onValueChange={(nextDraft) => {
                  if (!selectedConversationId) return;
                  setDrafts((current) => ({ ...current, [selectedConversationId]: nextDraft }));
                }}
                onSubmit={(event) => void sendMessage(event)}
              />
              <p className="composer-caption">
                {latestRun?.status === 'stop-unconfirmed'
                  ? 'A new message is blocked because process cleanup could not be confirmed.'
                  : activeRun
                    ? 'Wait for this run to finish, or stop it from Live activity.'
                    : 'Enter to send · Shift + Enter for a new line'}
              </p>
            </div>
          </>
        )}
      </main>

      <ActivityPanel
        run={latestRun}
        events={runEvents}
        dataRoot={snapshot.dataRoot}
        now={now}
        stopping={action === 'stop'}
        onStop={(runId) => void stopRun(runId)}
      />

      {!selectedConversation && error ? (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
