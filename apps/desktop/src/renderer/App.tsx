import { useChat } from '@ai-sdk/react';
import { NativeChatSession } from './chat-transport';
import HistoryPanel from './HistoryPanel';
import MemoryPanel from './MemoryPanel';
import WorkspaceHome from './WorkspaceHome';
import AppSettings from './AppSettings';
import './app-navigation.css';
import { useEffect, useMemo, useRef } from 'react';
import ProjectSettings from './ProjectSettings';
import ReviewPanel from './ReviewPanel';
import ProjectSetup from './ProjectSetup';
import Sidebar from './Sidebar';
import Welcome from './Welcome';
import ActivityPanel from './ActivityPanel';
import { BLOCKING_STATUSES } from './workspace-helpers';
import { useWorkspaceSession } from './useWorkspaceSession';
import { useConversationActions } from './useConversationActions';
import ConversationScreen from './ConversationScreen';

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
          <ConversationScreen
            selectedConversation={selectedConversation}
            selectedProject={selectedProject}
            selectedHarnessId={selectedHarnessId}
            harness={harness}
            latestRun={latestRun}
            snapshot={snapshot}
            selectedConversationId={selectedConversationId}
            chatMessages={chatMessages}
            chatError={chatError}
            chatSession={chatSession}
            messageScrollRef={messageScrollRef}
            nearMessageEnd={nearMessageEnd}
            action={action}
            checking={checking}
            cleanupBlocked={Boolean(cleanupBlocked)}
            activeRun={Boolean(activeRun)}
            composerDisabled={composerDisabled}
            harnessReason={harnessReason}
            settingsError={settingsError}
            selectionAvailable={selectionAvailable}
            modeAvailable={modeAvailable}
            hasOverride={hasOverride}
            selectedModelChoice={selectedModelChoice}
            selectedDraft={selectedDraft}
            integration={integration}
            error={error}
            setError={setError}
            setDrafts={setDrafts}
            setRunExecution={setRunExecution}
            changeMode={changeMode}
            openReview={openReview}
            setHistoryProjectId={setHistoryProjectId}
            setMemoryProjectId={setMemoryProjectId}
            setSettingsProjectId={setSettingsProjectId}
            integrate={integrate}
            changeSelection={changeSelection}
            changeHarness={changeHarness}
            sendMessage={sendMessage}
          />
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
