import type { FormEvent, MutableRefObject } from 'react';
import type { ExecutionMode, HarnessId, HarnessSelection } from '@randolph/runtime/contracts';
import type { NativeChatSession } from './chat-transport';
import { displayError } from './workspace-helpers';
import type { useWorkspaceSession } from './useWorkspaceSession';

type Session = ReturnType<typeof useWorkspaceSession>;

export function useConversationActions(session: Session, chatSession: NativeChatSession, nearMessageEnd: MutableRefObject<boolean>) {
  const {
    action,
    setAction,
    setError,
    selectedConversationId,
    selectedConversation,
    selectedDraft,
    selectedModelChoice,
    selectionAvailable,
    modeAvailable,
    settingsError,
    currentReview,
    selectedProject,
    setSelectedReviewId,
    setSelectedConversationId,
    setScreen,
    setDrafts,
    reloadSnapshot,
  } = session;

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
    if (!conversationId || !text || !model || !effort || action || !selectionAvailable || !modeAvailable || settingsError) return;
    setAction('send');
    setError(undefined);
    try {
      await chatSession.send(text);
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

  const changeHarness = (nextHarness: HarnessId) => {
    void (async () => {
      setAction('settings'); setError(undefined);
      try {
        const info = await window.randolph.harness(selectedProject?.id, undefined, nextHarness);
        const nextModel = info.models[0];
        if (!nextModel) throw new Error(info.reason ?? `${nextHarness} has no available models.`);
        await window.randolph.setConversationSelection({ conversationId: selectedConversationId!, selection: { harness: nextHarness, model: nextModel.id, effort: nextModel.defaultEffort } });
        await reloadSnapshot();
      } catch (cause) { setError(`Could not select ${nextHarness}: ${displayError(cause)}`); }
      finally { setAction(undefined); }
    })();
  };

  return { selectConversation, addProject, createConversation, sendMessage, changeSelection, changeMode, openReview, integrate, stopRun, changeHarness };
}
