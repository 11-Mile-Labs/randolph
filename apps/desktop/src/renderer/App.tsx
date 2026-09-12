import HistoryPanel from './HistoryPanel';
import MemoryPanel from './MemoryPanel';
import WorkspaceHome from './WorkspaceHome';
import AppSettings from './AppSettings';
import './app-navigation.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  Conversation,
  ExecutionMode,
  HarnessInfo,
  HarnessModel,
  HarnessSelection,
  Message,
  Project,
  Run,
  RunEvent,
  WorkspaceSnapshot,
  AppSettingsSnapshot,
} from '@randolph/runtime/contracts';
import ProjectSettings from './ProjectSettings';
import ReviewPanel from './ReviewPanel';

const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  projects: [],
  conversations: [],
  runs: [],
  messages: [],
  events: [],
  reviews: [],
  dataRoot: '',
};

const BLOCKING_STATUSES = new Set<Run['status']>(['starting', 'running', 'stopping', 'stop-unconfirmed']);
const NATIVE_EVENT_TYPES = new Set(['activity', 'session.started', 'message.delta', 'approval.denied', 'command.completed', 'file.changed', 'verification.check-started', 'verification.check-finished', 'verification.output']);

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
  return <img className="logo-mark" src="/randolph.png" alt="" />;
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
  screen: 'workspace' | 'chat' | 'settings';
  busy: boolean;
  onAddProject: () => void;
  onCreateConversation: (projectId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenWorkspace: () => void;
  onOpenSettings: () => void;
  onOpenProjectMemory: (projectId: string) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onOpenProjectHistory: (projectId: string) => void;
};

function Sidebar({
  projects,
  conversations,
  events,
  selectedConversationId,
  screen,
  busy,
  onAddProject,
  onCreateConversation,
  onSelectConversation,
  onOpenWorkspace,
  onOpenSettings,
  onOpenProjectMemory,
  onOpenProjectSettings,
  onOpenProjectHistory,
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

      <nav className="app-navigation" aria-label="Application">
        <button className={screen === 'workspace' ? 'selected' : ''} type="button" onClick={onOpenWorkspace} aria-current={screen === 'workspace' ? 'page' : undefined}>Workspace</button>
        <button className={screen === 'settings' ? 'selected' : ''} type="button" onClick={onOpenSettings} aria-current={screen === 'settings' ? 'page' : undefined}>Settings</button>
      </nav>

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
                  <div className="project-links" aria-label={`${project.name} tools`}>
                    <button type="button" onClick={() => onOpenProjectMemory(project.id)}>Memory</button>
                    <button type="button" onClick={() => onOpenProjectHistory(project.id)}>Run history</button>
                    <button type="button" onClick={() => onOpenProjectSettings(project.id)}>Project settings</button>
                  </div>
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
  const visibleEvents = events.filter(event => event.type.startsWith('run.') || event.type.startsWith('verification.') || event.type.startsWith('delivery.') || event.type.startsWith('review.') || event.type === 'command.completed' || event.type === 'file.changed' || event.type === 'session.started' || event.type === 'approval.denied' || event.sequence === lastResponse?.sequence || (event.data.method === 'item/started' && event.data.itemType === 'commandExecution')).slice(-12);


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

          {run.checkpointError ? <p className="inline-error" role="status">Checkpoint unavailable: {run.checkpointError}</p> : run.checkpoints?.length ? <p className="muted-copy">{run.checkpoints.length} recoverable checkpoints · Open Run history to restore</p> : null}
          {run.memory?.references.length ? <details className="run-context"><summary>{run.memory.references.length} supplied lessons · ~{run.memory.estimatedTokens} tokens (estimate)</summary><pre>{run.memory.text}</pre></details> : null}
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
      <small>Code mode edits an isolated Git worktree and requires final review before delivery.</small>
    </div>
  );
}

type ComposerProps = {
  harness?: HarnessInfo;
  model: string;
  effort: string;
  value: string;
  disabled: boolean;
  settingsDisabled: boolean;
  sendBlocked: boolean;
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
  settingsDisabled,
  sendBlocked,
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
              disabled={settingsDisabled || !harness?.available}
              onChange={(event) => {
                const next = harness?.models.find((item) => item.id === event.target.value);
                if (next) onModelChange(next);
              }}
            >
              {!selectedModel ? <option value={model}>{model ? `${model} (unavailable)` : 'No models available'}</option> : null}
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
              disabled={settingsDisabled || !selectedModel}
              onChange={(event) => onEffortChange(event.target.value)}
            >
              {!selectedModel?.efforts.includes(effort) ? <option value={effort}>{effort ? `${effort} (unavailable)` : 'No effort available'}</option> : null}
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
          disabled={disabled || sendBlocked || sending || value.trim().length === 0 || !model || !effort}
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
  const [appSettings, setAppSettings] = useState<AppSettingsSnapshot>();
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [screen, setScreen] = useState<'workspace' | 'chat' | 'settings'>('workspace');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [settingsProjectId, setSettingsProjectId] = useState<string>();
  const [historyProjectId, setHistoryProjectId] = useState<string>();
  const [memoryProjectId, setMemoryProjectId] = useState<string>();
  const [selectedReviewId, setSelectedReviewId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'project' | 'conversation' | 'send' | 'stop' | 'settings' | 'review'>();
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

  const applyTheme = useCallback((theme: AppSettingsSnapshot['value']['theme']) => {
    document.documentElement.dataset.theme = theme;
  }, []);

  const reloadAppSettings = useCallback(async () => {
    try {
      const next = await window.randolph.appSettings();
      setAppSettings(next);
      applyTheme(next.value.theme);
    } catch (settingsError) {
      setError(`Could not load application settings: ${displayError(settingsError)}`);
    }
  }, [applyTheme]);

  useEffect(() => {
    void reloadSnapshot();
    void reloadAppSettings();
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
    const unsubscribeNavigation = window.randolph.onNavigate(destination => setScreen(destination));
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); setScreen('settings'); }
    };
    window.addEventListener('keydown', onShortcut);
    const onFocus = () => { void reloadSnapshot(); };
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeNavigation();
      window.removeEventListener('keydown', onShortcut);
      window.removeEventListener('focus', onFocus);
    };
  }, [reloadAppSettings, reloadSnapshot]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedConversation = snapshot.conversations.find((item) => item.id === selectedConversationId);
  const selectedProject = selectedConversation
    ? snapshot.projects.find((item) => item.id === selectedConversation.projectId)
    : undefined;

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
  const integration = conversationRuns.find(run => run.integration)?.integration;
  const runEvents = latestRun ? conversationEvents.filter((event) => event.runId === latestRun.id) : [];
  const messages = snapshot.messages
    .filter((message) => message.conversationId === selectedConversationId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const historyRuns = historyProjectId
    ? snapshot.runs.filter(run => run.projectId === historyProjectId).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    : conversationRuns;
  const historyMessages = historyProjectId
    ? snapshot.messages.filter(message => historyRuns.some(run => run.id === message.runId)).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    : messages;
  const selectedDraft = selectedConversationId ? (drafts[selectedConversationId] ?? '') : '';
  const hasOverride = Boolean(selectedConversation?.model || selectedConversation?.effort);
  const selectedModelChoice = hasOverride
    ? { model: selectedConversation!.model, effort: selectedConversation!.effort }
    : selectedProject?.harnessSettings?.defaults ?? { model: harness?.models[0]?.id ?? '', effort: harness?.models[0]?.defaultEffort ?? '' };
  const settingsError = selectedProject?.harnessSettings?.error;
  const selectionAvailable = Boolean(harness?.models.some(item => item.id === selectedModelChoice.model && item.efforts.includes(selectedModelChoice.effort)));
  const settingsProject = snapshot.projects.find(item => item.id === settingsProjectId);
  const currentReview = snapshot.reviews.findLast(item => item.conversationId === selectedConversationId);
  const selectedReview = snapshot.reviews.find(item => item.id === selectedReviewId);
  const checking = currentReview?.status === 'checking';
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
    if (!selectedConversation || screen !== 'chat') return;
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
  }, [selectedConversation, snapshot.events, screen]);

  const selectConversation = (conversationId: string) => {
    nearMessageEnd.current = true;
    setSelectedConversationId(conversationId);
    setScreen('chat');
    setError(undefined);
    void reloadSnapshot();
  };

  const addProject = async () => {
    setAction('project');
    setError(undefined);
    try {
      const project = await window.randolph.addProject();
      if (!project) return;
      const conversation = await window.randolph.createConversation(project.id);
      setSelectedConversationId(conversation.id);
      setScreen('chat');
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
      setScreen('chat');
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
    if (!conversationId || !text || !model || !effort || action || !selectionAvailable || settingsError) return;
    setAction('send');
    setError(undefined);
    try {
      await window.randolph.send({ conversationId, text });
      setDrafts((current) =>
        current[conversationId]?.trim() === text ? { ...current, [conversationId]: '' } : current,
      );
      await reloadSnapshot();
    } catch (sendError) {
      setError(`Message was not sent: ${displayError(sendError)}`);
      await reloadSnapshot();
    } finally {
      setAction(undefined);
    }
  };

  const changeSelection = async (selection: HarnessSelection | null) => {
    if (!selectedConversationId || action) return;
    setAction('settings'); setError(undefined);
    try {
      await window.randolph.setConversationSelection({ conversationId: selectedConversationId, selection });
      await reloadSnapshot();
    } catch (cause) { setError(`Could not save conversation settings: ${displayError(cause)}`); }
    finally { setAction(undefined); }
  };
  const changeMode = async (executionMode: ExecutionMode) => {
    if (!selectedConversationId || action) return;
    setAction('settings'); setError(undefined);
    try { await window.randolph.setExecutionMode({ conversationId: selectedConversationId, executionMode }); await reloadSnapshot(); }
    catch (cause) { setError(displayError(cause)); }
    finally { setAction(undefined); }
  };
  const openReview = async (fresh = false) => {
    if (!selectedConversationId || action) return;
    if (!fresh && currentReview && currentReview.status !== 'stale') { setSelectedReviewId(currentReview.id); return; }
    setAction('review'); setError(undefined);
    try {
      const review = await window.randolph.prepareReview(selectedConversationId);
      await reloadSnapshot(); setSelectedReviewId(review.id);
    } catch (cause) { if (fresh) throw cause; setError(displayError(cause)); }
    finally { setAction(undefined); }
  };

  const integrate = async (resolveConflicts = false) => {
    if (!selectedConversationId || action) return;
    setAction('review'); setError(undefined);
    try {
      if (resolveConflicts) await window.randolph.confirmIntegration(selectedConversationId);
      else await window.randolph.integrateConversation(selectedConversationId);
    } catch (cause) { setError(displayError(cause)); }
    finally { await reloadSnapshot(); setAction(undefined); }
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
  const cleanupBlocked = conversationRuns.some(run => run.cleanupUnconfirmed || run.status === 'stop-unconfirmed') || snapshot.reviews.some(review => review.conversationId === selectedConversationId && review.status === 'stop-unconfirmed');
  const composerDisabled =
    Boolean(activeRun) || checking || cleanupBlocked || integration?.status === 'interrupted' || integration?.status === 'applying' || !harness?.available || !harness.authenticated || harness.models.length === 0;
  const harnessReason = harness
    ? !harness.available || !harness.authenticated
      ? (harness.reason ?? 'Authentication or availability could not be confirmed.')
      : harness.models.length === 0
        ? 'No models were reported by the native harness.'
        : undefined
    : undefined;

  return (
    <div className="app-shell" data-screen={screen}>
      <Sidebar
        projects={snapshot.projects}
        conversations={snapshot.conversations}
        events={snapshot.events}
        selectedConversationId={screen === 'chat' ? selectedConversationId : undefined}
        screen={screen}
        busy={action === 'project' || action === 'conversation'}
        onAddProject={() => void addProject()}
        onCreateConversation={(projectId) => void createConversation(projectId)}
        onSelectConversation={selectConversation}
        onOpenWorkspace={() => setScreen('workspace')}
        onOpenSettings={() => setScreen('settings')}
        onOpenProjectMemory={setMemoryProjectId}
        onOpenProjectSettings={setSettingsProjectId}
        onOpenProjectHistory={setHistoryProjectId}
      />

      <main className="workspace">
        {screen === 'settings' ? <AppSettings settings={appSettings} harness={harness} snapshot={snapshot} onReload={reloadAppSettings} onSaved={next => { setAppSettings(next); applyTheme(next.value.theme); }} /> : screen === 'workspace' ? <WorkspaceHome
          projects={snapshot.projects}
          conversations={snapshot.conversations}
          runs={snapshot.runs}
          busy={action === 'project' || action === 'conversation'}
          onAddProject={() => void addProject()}
          onOpenConversation={selectConversation}
          onCreateConversation={projectId => void createConversation(projectId)}
          onOpenProjectSettings={setSettingsProjectId}
          onOpenMemory={setMemoryProjectId}
          onOpenHistory={setHistoryProjectId}
        /> : loading ? (
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
                <span className="eyebrow">{selectedConversation.executionMode === 'code' ? 'Code workspace' : 'Read-only workspace'}</span>
                <h1>{selectedConversation.title}</h1>
                <p>{selectedProject?.name}{latestRun && latestRun.workspace !== selectedProject?.root ? (latestRun.executionMode === "code" ? " · Isolated worktree" : " · Committed snapshot") : ""}</p>
              </div>
              <div className="header-actions">
                {harness?.version ? <span className="version-chip">Codex {harness.version}</span> : null}
                <button className="secondary-button" type="button" onClick={() => setHistoryProjectId(selectedConversation.projectId)}>Run history</button>
                <button className="secondary-button" type="button" onClick={() => setMemoryProjectId(selectedConversation.projectId)}>Memory</button>
                <select aria-label="Conversation mode" value={selectedConversation.executionMode ?? 'read-only'} disabled={Boolean(action) || Boolean(activeRun) || checking || cleanupBlocked} onChange={event => void changeMode(event.target.value as ExecutionMode)}>
                  <option value="read-only">Read-only</option><option value="code" disabled={!harness?.executionModes?.includes('code')}>Code</option>
                </select>
                {selectedConversation.executionMode === 'code' ? <button className="secondary-button" type="button" disabled={Boolean(action) || Boolean(activeRun) || !latestRun} onClick={() => void openReview()}>{checking ? 'Checks running' : 'Review changes'}</button> : null}
                <button className="secondary-button" type="button" disabled={Boolean(action)} onClick={() => setSettingsProjectId(selectedProject?.id)}>Project settings</button>
              </div>
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
                  <h2>{selectedConversation.executionMode === 'code' ? 'What should Randolph build?' : 'What should Randolph inspect?'}</h2>
                  <p>{selectedConversation.executionMode === 'code' ? 'Describe the change. Work stays in an isolated worktree until you review and approve delivery.' : 'Ask a question about the project. Native events will be recorded alongside the response.'}</p>
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
              {integration && integration.status !== 'integrated' && integration.status !== 'resolved' ? <div className="integration-attention" role="status">
                <strong>{integration.status === 'conflicted' ? 'Parent integration needs conflict resolution' : 'Parent integration was interrupted'}</strong>
                <p>{integration.error || integration.plan.conflicts.join(', ')}</p>
                {integration.status === 'conflicted' ? <>
                  <button className="secondary-button" disabled={Boolean(action) || Boolean(activeRun)} onClick={() => setDrafts(current => ({ ...current, [selectedConversationId!]: `Resolve the parent integration conflicts in ${integration.plan.conflicts.join(', ')}. Preserve the intended changes from both sides. Run relevant checks. Do not commit or push.` }))}>Prepare conflict-resolution message</button>
                  <button className="secondary-button" disabled={Boolean(action) || Boolean(activeRun)} onClick={() => void integrate(true)}>Confirm conflicts resolved</button>
                </> : <button className="secondary-button" disabled={Boolean(action) || Boolean(activeRun)} onClick={() => void integrate()}>Continue integration</button>}
              </div> : null}
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
              {settingsError ? <p className="harness-warning" role="alert">{settingsError} Open Project settings to reload after correcting the file.</p> : null}
              {!settingsError && harness?.available && !selectionAvailable ? <p className="harness-warning" role="alert">The saved model or effort is unavailable. Choose a replacement or update the project default before sending.</p> : null}
              <div className="selection-source">
                <span>{action === 'settings' ? 'Saving choice…' : hasOverride ? 'Conversation override' : selectedProject?.harnessSettings?.defaults ? 'Project default' : 'No project default saved'}</span>
                {hasOverride ? <button type="button" disabled={Boolean(action)} onClick={() => void changeSelection(null)}>Use project default</button> : null}
              </div>
              <Composer
                harness={harness}
                model={selectedModelChoice.model}
                effort={selectedModelChoice.effort}
                value={selectedDraft}
                disabled={composerDisabled}
                settingsDisabled={Boolean(action)}
                sendBlocked={Boolean(action) || !selectionAvailable || Boolean(settingsError)}
                sending={action === 'send'}
                onModelChange={(nextModel) => {
                  void changeSelection({ harness: 'codex', model: nextModel.id, effort: nextModel.defaultEffort });
                }}
                onEffortChange={(nextEffort) => {
                  void changeSelection({ harness: 'codex', model: selectedModelChoice.model, effort: nextEffort });
                }}
                onValueChange={(nextDraft) => {
                  if (!selectedConversationId) return;
                  setDrafts((current) => ({ ...current, [selectedConversationId]: nextDraft }));
                }}
                onSubmit={(event) => void sendMessage(event)}
              />
              <p className="composer-caption">
                {integration?.status === 'interrupted' ? 'Continue parent integration before sending another message.' : cleanupBlocked
                  ? 'A new message is blocked because process cleanup could not be confirmed.'
                  : activeRun
                    ? 'Wait for this run to finish, or stop it from Live activity.'
                    : 'Enter to send · Shift + Enter for a new line'}
              </p>
            </div>
          </>
        )}
      </main>

      {screen === 'chat' ? <ActivityPanel
        run={latestRun}
        events={runEvents}
        dataRoot={snapshot.dataRoot}
        now={now}
        stopping={action === 'stop'}
        onStop={(runId) => void stopRun(runId)}
      /> : null}

      {settingsProject ? <ProjectSettings key={settingsProject.id} project={settingsProject} harness={harness} onClose={() => setSettingsProjectId(undefined)} onChanged={reloadSnapshot} /> : null}
      {historyProjectId ? <HistoryPanel key={historyProjectId} runs={historyRuns} messages={historyMessages} events={snapshot.events} reviews={snapshot.reviews} onClose={() => setHistoryProjectId(undefined)} /> : null}
      {memoryProjectId ? <MemoryPanel projectId={memoryProjectId} onClose={() => setMemoryProjectId(undefined)} /> : null}
      {selectedReview ? <ReviewPanel key={selectedReview.id} review={selectedReview} onClose={() => setSelectedReviewId(undefined)} onChanged={reloadSnapshot} onRefresh={() => openReview(true)} /> : null}

      {(screen !== 'chat' || !selectedConversation) && error ? (
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
