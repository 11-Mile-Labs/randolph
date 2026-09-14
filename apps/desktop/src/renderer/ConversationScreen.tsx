import type { Dispatch, FormEvent, MutableRefObject, RefObject, SetStateAction } from 'react';
import type {
  Conversation,
  ExecutionMode,
  HarnessId,
  HarnessInfo,
  HarnessSelection,
  IntegrationState,
  Project,
  Run,
  RunExecutionSnapshot,
  WorkspaceSnapshot,
} from '@randolph/runtime/contracts';
import type { NativeChatMessage, NativeChatSession } from './chat-transport';
import RunActivity from './RunActivity';
import DelegationConversation from './DelegationConversation';
import Composer from './Composer';
import MessageBubble from './MessageBubble';
import { LogoMark } from './icons';
import type { AppAction } from './useWorkspaceSession';

export type ConversationScreenProps = {
  selectedConversation: Conversation;
  selectedProject?: Project;
  selectedHarnessId: HarnessId;
  harness?: HarnessInfo;
  latestRun?: Run;
  snapshot: WorkspaceSnapshot;
  selectedConversationId?: string;
  chatMessages: NativeChatMessage[];
  chatError?: Error;
  chatSession: NativeChatSession;
  messageScrollRef: RefObject<HTMLDivElement | null>;
  nearMessageEnd: MutableRefObject<boolean>;
  action?: AppAction;
  checking: boolean;
  cleanupBlocked: boolean;
  activeRun: boolean | undefined;
  composerDisabled: boolean;
  harnessReason?: string;
  settingsError?: string;
  selectionAvailable: boolean;
  modeAvailable: boolean;
  hasOverride: boolean;
  selectedModelChoice: { harness: HarnessId; model: string; effort: string };
  selectedDraft: string;
  integration?: IntegrationState;
  error?: string;
  setError: (value: string | undefined) => void;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setRunExecution: (value: RunExecutionSnapshot | undefined) => void;
  changeMode: (mode: ExecutionMode) => void | Promise<void>;
  openReview: () => void | Promise<void>;
  setHistoryProjectId: (id: string) => void;
  setMemoryProjectId: (id: string) => void;
  setSettingsProjectId: (id: string | undefined) => void;
  integrate: (resolveConflicts?: boolean) => void | Promise<void>;
  changeSelection: (selection: HarnessSelection | null) => void | Promise<void>;
  changeHarness: (harness: HarnessId) => void;
  sendMessage: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export default function ConversationScreen(props: ConversationScreenProps) {
  const {
    selectedConversation,
    selectedProject,
    selectedHarnessId,
    harness,
    latestRun,
    snapshot,
    selectedConversationId,
    chatMessages,
    chatError,
    chatSession,
    messageScrollRef,
    nearMessageEnd,
    action,
    checking,
    cleanupBlocked,
    activeRun,
    composerDisabled,
    harnessReason,
    settingsError,
    selectionAvailable,
    modeAvailable,
    hasOverride,
    selectedModelChoice,
    selectedDraft,
    integration,
    error,
    setError,
    setDrafts,
    setRunExecution,
    changeMode,
    openReview,
    setHistoryProjectId,
    setMemoryProjectId,
    setSettingsProjectId,
    integrate,
    changeSelection,
    changeHarness,
    sendMessage,
  } = props;
  return (
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
              .filter((message) => message.parts.some((part) => part.type === 'text' && part.text))
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
                    (event) => event.runId === latestRun.id && event.type.startsWith('delegation.'),
                  )
                  .at(-1)?.sequence ?? 0
              }
            />
          </div>
        ) : null}
      </div>

      <div className="composer-area">
        {integration && integration.status !== 'integrated' && integration.status !== 'resolved' ? (
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
            <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">
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
            {harness.reason ?? 'This execution mode is not verified for the selected harness.'}
          </p>
        ) : null}
        {!settingsError && harness?.available && !selectionAvailable ? (
          <p className="harness-warning" role="alert">
            The saved model or effort is unavailable. Choose a replacement or update the project
            default before sending.
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
  );
}
