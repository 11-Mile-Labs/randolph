import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HarnessId,
  HarnessInfo,
  RunExecutionSnapshot,
  WorkspaceSnapshot,
  AppSettingsSnapshot,
} from '@randolph/runtime/contracts';
import { EMPTY_SNAPSHOT, displayError, latestSequence } from './workspace-helpers';

export type AppScreen = 'workspace' | 'chat' | 'settings';
export type AppAction = 'project' | 'conversation' | 'send' | 'stop' | 'settings' | 'review';

export function useWorkspaceSession() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [runExecution, setRunExecution] = useState<RunExecutionSnapshot>();
  const [defaultHarness, setDefaultHarness] = useState<HarnessInfo>();
  const [projectHarness, setProjectHarness] = useState<HarnessInfo>();
  const [appSettings, setAppSettings] = useState<AppSettingsSnapshot>();
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [screen, setScreen] = useState<AppScreen>('workspace');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [settingsProjectId, setSettingsProjectId] = useState<string>();
  const [setupProjectId, setSetupProjectId] = useState<string>();
  const [historyProjectId, setHistoryProjectId] = useState<string>();
  const [memoryProjectId, setMemoryProjectId] = useState<string>();
  const [selectedReviewId, setSelectedReviewId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<AppAction>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const loadVersion = useRef(0);

  const reloadSnapshot = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const next = await window.randolph.snapshot();
      if (version === loadVersion.current) setSnapshot(next);
    } catch (loadError) {
      if (version === loadVersion.current)
        setError(`Could not load workspace: ${displayError(loadError)}`);
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
        const info = await window.randolph.harness(undefined, undefined, 'codex');
        if (!disposed) setDefaultHarness(info);
      } catch (harnessError) {
        if (!disposed)
          setError(`Could not inspect the native harness: ${displayError(harnessError)}`);
      }
    };
    void loadHarness();
    const unsubscribe = window.randolph.onChanged(() => void reloadSnapshot());
    const unsubscribeNavigation = window.randolph.onNavigate((destination) =>
      setScreen(destination),
    );
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setScreen('settings');
      }
    };
    window.addEventListener('keydown', onShortcut);
    const onFocus = () => {
      void reloadSnapshot();
    };
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

  const selectedConversation = snapshot.conversations.find(
    (item) => item.id === selectedConversationId,
  );
  const selectedProject = selectedConversation
    ? snapshot.projects.find((item) => item.id === selectedConversation.projectId)
    : undefined;
  const selectedHarnessId: HarnessId =
    selectedConversation?.harness ??
    (selectedConversation?.model || selectedConversation?.effort
      ? 'codex'
      : (selectedProject?.harnessSettings?.defaults?.harness ?? 'codex'));
  const harness = selectedProject ? projectHarness : defaultHarness;

  useEffect(() => {
    let disposed = false;
    setProjectHarness(undefined);
    if (selectedProject)
      void (async () => {
        try {
          const info = await window.randolph.harness(
            selectedProject.id,
            undefined,
            selectedHarnessId,
          );
          if (!disposed) setProjectHarness(info);
        } catch (cause) {
          if (!disposed) setError(`Could not inspect this project's CLI: ${displayError(cause)}`);
        }
      })();
    return () => {
      disposed = true;
    };
  }, [selectedProject?.id, selectedProject?.harnessSettings?.revision, selectedHarnessId]);

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
  const execution = runExecution?.runId === latestRun?.id ? runExecution : undefined;
  const integration = conversationRuns.find((run) => run.integration)?.integration;
  const runEvents = latestRun
    ? conversationEvents.filter((event) => event.runId === latestRun.id)
    : [];
  const messages = snapshot.messages
    .filter((message) => message.conversationId === selectedConversationId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const historyRuns = historyProjectId
    ? snapshot.runs
        .filter((run) => run.projectId === historyProjectId)
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    : conversationRuns;
  const historyMessages = historyProjectId
    ? snapshot.messages
        .filter((message) => historyRuns.some((run) => run.id === message.runId))
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    : messages;
  const selectedDraft = selectedConversationId ? (drafts[selectedConversationId] ?? '') : '';
  const hasOverride = Boolean(
    selectedConversation?.harness || selectedConversation?.model || selectedConversation?.effort,
  );
  const selectedModelChoice = hasOverride
    ? {
        harness: selectedConversation!.harness ?? ('codex' as HarnessId),
        model: selectedConversation!.model,
        effort: selectedConversation!.effort,
      }
    : (selectedProject?.harnessSettings?.defaults ?? {
        harness: selectedHarnessId,
        model: harness?.models[0]?.id ?? '',
        effort: harness?.models[0]?.defaultEffort ?? '',
      });
  const settingsError = selectedProject?.harnessSettings?.error;
  const selectionAvailable = Boolean(
    harness?.models.some(
      (item) =>
        item.id === selectedModelChoice.model && item.efforts.includes(selectedModelChoice.effort),
    ),
  );
  const modeAvailable = Boolean(
    harness &&
    (harness.executionModes === undefined
      ? (selectedConversation?.executionMode ?? 'read-only') === 'read-only'
      : harness.executionModes.includes(selectedConversation?.executionMode ?? 'read-only')),
  );
  const settingsProject = snapshot.projects.find((item) => item.id === settingsProjectId);
  const currentReview = snapshot.reviews.findLast(
    (item) => item.conversationId === selectedConversationId,
  );
  const selectedReview = snapshot.reviews.find((item) => item.id === selectedReviewId);
  const checking = currentReview?.status === 'checking';

  useEffect(() => {
    if (!selectedConversation || screen !== 'chat') return;
    const newest = latestSequence(snapshot.events, selectedConversation.id);
    if (newest <= selectedConversation.lastReadSequence) return;
    let disposed = false;
    const markRead = async (): Promise<void> => {
      try {
        await window.randolph.markRead(selectedConversation.id);
      } catch (markError) {
        if (!disposed)
          setError(`Could not mark the conversation as read: ${displayError(markError)}`);
      }
    };
    void markRead();
    return () => {
      disposed = true;
    };
  }, [selectedConversation, snapshot.events, screen]);

  return {
    snapshot,
    setSnapshot,
    runExecution,
    setRunExecution,
    defaultHarness,
    appSettings,
    setAppSettings,
    selectedConversationId,
    setSelectedConversationId,
    screen,
    setScreen,
    drafts,
    setDrafts,
    settingsProjectId,
    setSettingsProjectId,
    setupProjectId,
    setSetupProjectId,
    historyProjectId,
    setHistoryProjectId,
    memoryProjectId,
    setMemoryProjectId,
    selectedReviewId,
    setSelectedReviewId,
    loading,
    action,
    setAction,
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
    conversationEvents,
    conversationRuns,
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
    currentReview,
    selectedReview,
    checking,
  };
}
