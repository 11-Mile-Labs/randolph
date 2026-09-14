import { useChat } from '@ai-sdk/react';
import { NativeChatSession } from './chat-transport';
import HistoryPanel from './HistoryPanel';
import MemoryPanel from './MemoryPanel';
import RunActivity from './RunActivity';
import DelegationConversation from './DelegationConversation';
import WorkspaceHome from './WorkspaceHome';
import AppSettings from './AppSettings';
import './app-navigation.css';
import { useEffect, useMemo, useRef } from 'react';
import type { ExecutionMode } from '@randolph/runtime/contracts';
import ProjectSettings from './ProjectSettings';
import ReviewPanel from './ReviewPanel';
import ProjectSetup from './ProjectSetup';
import Sidebar from './Sidebar';
import Welcome from './Welcome';
import Composer from './Composer';
import MessageBubble from './MessageBubble';
import ActivityPanel from './ActivityPanel';
import { LogoMark } from './icons';
import { BLOCKING_STATUSES } from './workspace-helpers';
import { useWorkspaceSession } from './useWorkspaceSession';
import { useConversationActions } from './useConversationActions';

export default function App() {
  const session = useWorkspaceSession();
  const {
    snapshot,
    setRunExecution,
    defaultHarness,
    appSettings,
    setAppSettings,
    selectedConversationId,
    screen,
    setScreen,
    setDrafts,
    setSettingsProjectId,
    setupProjectId,
    setSetupProjectId,
    historyProjectId,
    setHistoryProjectId,
    memoryProjectId,
    setMemoryProjectId,
    setSelectedReviewId,
    loading,
    action,
    error,
    setError,
    now,
    reloadSnapshot,
    applyTheme,
    reloadAppSettings,
    selectedConversation,
    selectedProject,
    selectedHarnessId,
    harness,
    latestRun,
    execution,
    integration,
    runEvents,
    historyRuns,
    historyMessages,
    selectedDraft,
    hasOverride,
    selectedModelChoice,
    settingsError,
    selectionAvailable,
    modeAvailable,
    settingsProject,
    selectedReview,
    checking,
  } = session;
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const nearMessageEnd = useRef(true);
  const chatSession = useMemo(
    () => new NativeChatSession(window.randolph, selectedConversationId ?? '', snapshot),
    [selectedConversationId],
  );
  const {
    messages: chatMessages,
    error: chatError,
    status: chatStatus,
  } = useChat({ chat: chatSession.chat });
  useEffect(() => chatSession.attach(), [chatSession]);
  useEffect(() => {
    chatSession.sync(snapshot);
  }, [chatSession, snapshot, chatStatus]);
  const {
    selectConversation,
    addProject,
    createConversation,
    sendMessage,
    changeSelection,
    changeMode,
    openReview,
    integrate,
    stopRun,
    changeHarness,
  } = useConversationActions(session, chatSession, nearMessageEnd);
  const lastMessage = chatMessages.at(-1);
  const lastMessageKey = lastMessage
    ? `${lastMessage.id}:${JSON.stringify(lastMessage.parts)}`
    : selectedConversationId;

  useEffect(() => {
    if (!nearMessageEnd.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = messageScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [lastMessageKey, selectedConversationId]);

  const activeRun = latestRun && BLOCKING_STATUSES.has(latestRun.status);
  const cleanupBlocked =
    execution?.cleanupRequired ||
    session.conversationRuns.some(
      (run) => run.cleanupUnconfirmed || run.status === 'stop-unconfirmed',
    ) ||
    snapshot.reviews.some(
      (review) =>
        review.conversationId === selectedConversationId && review.status === 'stop-unconfirmed',
    );
  const composerDisabled =
    Boolean(activeRun) ||
    checking ||
    cleanupBlocked ||
    integration?.status === 'interrupted' ||
    integration?.status === 'applying' ||
    !harness?.available ||
    !harness.authenticated ||
    harness.models.length === 0;
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
        onOpenProjectMemory={session.setMemoryProjectId}
        onOpenProjectSettings={setSettingsProjectId}
        onOpenProjectSetup={setSetupProjectId}
        onOpenProjectHistory={setHistoryProjectId}
      />

      <main className="workspace">
        {screen === 'settings' ? (
          <AppSettings
            settings={appSettings}
            harness={defaultHarness}
            snapshot={snapshot}
            onReload={reloadAppSettings}
            onSaved={(next) => {
              setAppSettings(next);
              applyTheme(next.value.theme);
            }}
          />
        ) : screen === 'workspace' ? (
          <WorkspaceHome
            projects={snapshot.projects}
            conversations={snapshot.conversations}
            runs={snapshot.runs}
            busy={action === 'project' || action === 'conversation'}
            onAddProject={() => void addProject()}
            onOpenConversation={selectConversation}
            onCreateConversation={(projectId) => void createConversation(projectId)}
            onOpenProjectSettings={setSettingsProjectId}
            onOpenProjectSetup={setSetupProjectId}
            onOpenMemory={session.setMemoryProjectId}
            onOpenHistory={setHistoryProjectId}
          />
        ) : loading ? (
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
                <span className="eyebrow">
                  {selectedConversation.executionMode === 'code'
                    ? 'Code workspace'
                    : 'Read-only workspace'}
                </span>
                <h1>{selectedConversation.title}</h1>
                <p>
                  {selectedProject?.name}
                  {latestRun && latestRun.workspace !== selectedProject?.root
                    ? latestRun.executionMode === 'code'
                      ? ' · Isolated worktree'
                      : ' · Committed snapshot'
                    : ''}
                </p>
              </div>
              <div className="header-actions">
                {harness?.version ? (
                  <span className="version-chip">
                    {selectedHarnessId === 'grok' ? 'Grok' : 'Codex'} {harness.version}
                  </span>
                ) : null}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setHistoryProjectId(selectedConversation.projectId)}
                >
                  Run history
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setMemoryProjectId(selectedConversation.projectId)}
                >
                  Memory
                </button>
                <select
                  aria-label="Conversation mode"
                  value={selectedConversation.executionMode ?? 'read-only'}
                  disabled={Boolean(action) || Boolean(activeRun) || checking || cleanupBlocked}
                  onChange={(event) => void changeMode(event.target.value as ExecutionMode)}
                >
                  <option value="read-only">Read-only</option>
                  <option value="code" disabled={!harness?.executionModes?.includes('code')}>
                    Code
                  </option>
                </select>
                {selectedConversation.executionMode === 'code' ? (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={Boolean(action) || Boolean(activeRun) || !latestRun}
                    onClick={() => void openReview()}
                  >
                    {checking ? 'Checks running' : 'Review changes'}
                  </button>
                ) : null}
                <button
                  className="secondary-button"
                  type="button"
                  disabled={Boolean(action)}
                  onClick={() => setSettingsProjectId(selectedProject?.id)}
                >
                  Project settings
                </button>
              </div>
            </header>

            <div
              className="message-scroll"
              aria-live="polite"
              ref={messageScrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                nearMessageEnd.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 96;
              }}
            >
              {chatMessages.length === 0 ? (
                <div className="conversation-empty">
                  <LogoMark />
                  <h2>
                    {selectedConversation.executionMode === 'code'
                      ? 'What should Randolph build?'
                      : 'What should Randolph inspect?'}
                  </h2>
                  <p>
                    {selectedConversation.executionMode === 'code'
                      ? 'Describe the change. Work stays in an isolated worktree until you review and approve delivery.'
                      : 'Ask a question about the project. Native events will be recorded alongside the response.'}
                  </p>
                </div>
              ) : (
                <div className="message-column">
                  {chatMessages
                    .filter((message) =>
                      message.parts.some((part) => part.type === 'text' && part.text),
                    )
                    .map((message) => (
                      <MessageBubble message={message} key={message.id} />
                    ))}
                </div>
              )}
              {latestRun ? (
                <div className="message-column">
                  <RunActivity
                    key={`activity-${latestRun.id}`}
                    runId={latestRun.id}
                    onSnapshot={setRunExecution}
                  />
                  <DelegationConversation
                    key={latestRun.id}
                    runId={latestRun.id}
                    revision={
                      snapshot.events
                        .filter(
                          (event) =>
                            event.runId === latestRun.id && event.type.startsWith('delegation.'),
                        )
                        .at(-1)?.sequence ?? 0
                    }
                  />
                </div>
              ) : null}
            </div>

            <div className="composer-area">
              {integration &&
              integration.status !== 'integrated' &&
              integration.status !== 'resolved' ? (
                <div className="integration-attention" role="status">
                  <strong>
                    {integration.status === 'conflicted'
                      ? 'Parent integration needs conflict resolution'
                      : 'Parent integration was interrupted'}
                  </strong>
                  <p>{integration.error || integration.plan.conflicts.join(', ')}</p>
                  {integration.status === 'conflicted' ? (
                    <>
                      <button
                        className="secondary-button"
                        disabled={Boolean(action) || Boolean(activeRun)}
                        onClick={() =>
                          setDrafts((current) => ({
                            ...current,
                            [selectedConversationId!]: `Resolve the parent integration conflicts in ${integration.plan.conflicts.join(', ')}. Preserve the intended changes from both sides. Run relevant checks. Do not commit or push.`,
                          }))
                        }
                      >
                        Prepare conflict-resolution message
                      </button>
                      <button
                        className="secondary-button"
                        disabled={Boolean(action) || Boolean(activeRun)}
                        onClick={() => void integrate(true)}
                      >
                        Confirm conflicts resolved
                      </button>
                    </>
                  ) : (
                    <button
                      className="secondary-button"
                      disabled={Boolean(action) || Boolean(activeRun)}
                      onClick={() => void integrate()}
                    >
                      Continue integration
                    </button>
                  )}
                </div>
              ) : null}
              {error ? (
                <div className="composer-error" role="alert">
                  <strong>Randolph hit a snag.</strong>
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => setError(undefined)}
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </div>
              ) : null}
              {chatError ? (
                <div className="composer-error" role="alert">
                  <span>Chat stream: {chatError.message}</span>
                  <button
                    type="button"
                    onClick={() => {
                      chatSession.chat.clearError();
                      void chatSession.connect();
                    }}
                  >
                    Reconnect chat
                  </button>
                </div>
              ) : null}
              {harnessReason ? (
                <p className="harness-warning">Native harness unavailable: {harnessReason}</p>
              ) : null}
              {settingsError ? (
                <p className="harness-warning" role="alert">
                  {settingsError} Open Project settings to reload after correcting the file.
                </p>
              ) : null}
              {harness?.authenticated && !modeAvailable ? (
                <p className="harness-warning" role="alert">
                  {harness.reason ??
                    'This execution mode is not verified for the selected harness.'}
                </p>
              ) : null}
              {!settingsError && harness?.available && !selectionAvailable ? (
                <p className="harness-warning" role="alert">
                  The saved model or effort is unavailable. Choose a replacement or update the
                  project default before sending.
                </p>
              ) : null}
              <div className="selection-source">
                <span>
                  {action === 'settings'
                    ? 'Saving choice…'
                    : hasOverride
                      ? 'Conversation override'
                      : selectedProject?.harnessSettings?.defaults
                        ? 'Project default'
                        : 'No project default saved'}
                </span>
                {hasOverride ? (
                  <button
                    type="button"
                    disabled={Boolean(action)}
                    onClick={() => void changeSelection(null)}
                  >
                    Use project default
                  </button>
                ) : null}
              </div>
              <Composer
                harness={harness}
                model={selectedModelChoice.model}
                effort={selectedModelChoice.effort}
                value={selectedDraft}
                disabled={composerDisabled}
                settingsDisabled={Boolean(action)}
                sendBlocked={
                  Boolean(action) || !selectionAvailable || !modeAvailable || Boolean(settingsError)
                }
                sending={action === 'send'}
                harnessId={selectedModelChoice.harness}
                onHarnessChange={changeHarness}
                onModelChange={(nextModel) => {
                  void changeSelection({
                    harness: selectedModelChoice.harness,
                    model: nextModel.id,
                    effort: nextModel.defaultEffort,
                  });
                }}
                onEffortChange={(nextEffort) => {
                  void changeSelection({
                    harness: selectedModelChoice.harness,
                    model: selectedModelChoice.model,
                    effort: nextEffort,
                  });
                }}
                onValueChange={(nextDraft) => {
                  if (!selectedConversationId) return;
                  setDrafts((current) => ({ ...current, [selectedConversationId]: nextDraft }));
                }}
                onSubmit={(event) => void sendMessage(event)}
              />
              <p className="composer-caption">
                {integration?.status === 'interrupted'
                  ? 'Continue parent integration before sending another message.'
                  : cleanupBlocked
                    ? 'A new message is blocked because process cleanup could not be confirmed.'
                    : activeRun
                      ? 'Wait for this run to finish, or stop it from Live activity.'
                      : 'Enter to send · Shift + Enter for a new line'}
              </p>
            </div>
          </>
        )}
      </main>

      {screen === 'chat' ? (
        <ActivityPanel
          run={latestRun}
          execution={execution}
          events={runEvents}
          dataRoot={snapshot.dataRoot}
          now={now}
          stopping={action === 'stop'}
          onStop={(runId) => void stopRun(runId)}
        />
      ) : null}

      {settingsProject ? (
        <ProjectSettings
          key={settingsProject.id}
          project={settingsProject}
          onClose={() => setSettingsProjectId(undefined)}
          onChanged={reloadSnapshot}
        />
      ) : null}
      {setupProjectId
        ? (() => {
            const project = snapshot.projects.find((item) => item.id === setupProjectId);
            return project ? (
              <ProjectSetup
                key={project.id}
                project={project}
                onClose={() => setSetupProjectId(undefined)}
                onChanged={reloadSnapshot}
              />
            ) : null;
          })()
        : null}
      {historyProjectId ? (
        <HistoryPanel
          key={historyProjectId}
          runs={historyRuns}
          messages={historyMessages}
          events={snapshot.events}
          reviews={snapshot.reviews}
          onRecovered={async (id) => {
            await reloadSnapshot();
            setHistoryProjectId(undefined);
            selectConversation(id);
          }}
          onClose={() => setHistoryProjectId(undefined)}
        />
      ) : null}
      {memoryProjectId ? (
        <MemoryPanel projectId={memoryProjectId} onClose={() => setMemoryProjectId(undefined)} />
      ) : null}
      {selectedReview ? (
        <ReviewPanel
          key={selectedReview.id}
          review={selectedReview}
          onClose={() => setSelectedReviewId(undefined)}
          onChanged={reloadSnapshot}
          onRefresh={() => openReview(true)}
        />
      ) : null}

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
