import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@randolph/runtime/contracts';
const bridge: DesktopBridge = {
  snapshot: async () => ipcRenderer.invoke('randolph:snapshot'),
  chatEvents: async input => ipcRenderer.invoke('randolph:chat-events', input),
  appSettings: async () => ipcRenderer.invoke('randolph:app-settings'),
  saveAppSettings: async input => ipcRenderer.invoke('randolph:save-app-settings', input),
  saveGlobalMemory: async input => ipcRenderer.invoke('randolph:save-global-memory', input),
  onNavigate: listener => {
    let active = true;
    const navigate = (_event: unknown, value: unknown): void => {
      if (!active || !value || typeof value !== 'object' || !('destination' in value) || !('sequence' in value) || typeof value.sequence !== 'number' || (value.destination !== 'workspace' && value.destination !== 'settings')) return;
      listener(value.destination);
      void (async () => { try { await ipcRenderer.invoke('randolph:ack-navigation', value.sequence); } catch { /* Retain pending navigation until the host can acknowledge it. */ } })();
    };
    ipcRenderer.on('randolph:navigate', navigate);
    void (async () => { try { navigate(undefined, await ipcRenderer.invoke('randolph:initial-navigation')); } catch { /* The host may be closing. */ } })();
    return () => { active = false; ipcRenderer.removeListener('randolph:navigate', navigate); };
  },
  restoreCheckpoint: async input => ipcRenderer.invoke('randolph:restore-checkpoint', input),
  restartRun: async input => ipcRenderer.invoke('randolph:restart-run', input),
  rerunFromCheckpoint: async input => ipcRenderer.invoke('randolph:rerun-checkpoint', input),
  memorySnapshot: async id => ipcRenderer.invoke('randolph:memory', id),
  memoryCommand: async input => ipcRenderer.invoke('randolph:memory-command', input),
  memoryHistory: async (id, reference) => ipcRenderer.invoke('randolph:memory-history', { projectId: id, reference }),
  harness: async (projectId, executable) => ipcRenderer.invoke('randolph:harness', { projectId, executable }),
  harnessInstallations: async () => ipcRenderer.invoke('randolph:harness-installations'),
  addProject: async () => ipcRenderer.invoke('randolph:add-project'),
  createConversation: async id => ipcRenderer.invoke('randolph:create-conversation', id),
  saveProjectDefaults: async input => ipcRenderer.invoke('randolph:save-project-defaults', input),
  setConversationSelection: async input => ipcRenderer.invoke('randolph:conversation-selection', input),
  setExecutionMode: async input => ipcRenderer.invoke('randolph:execution-mode', input),
  integrateConversation: async id => ipcRenderer.invoke('randolph:integrate', id),
  confirmIntegration: async id => ipcRenderer.invoke('randolph:confirm-integration', id),
  prepareReview: async id => ipcRenderer.invoke('randolph:prepare-review', id),
  verifyReview: async id => ipcRenderer.invoke('randolph:verify-review', id),
  approveReview: async input => ipcRenderer.invoke('randolph:approve-review', input),
  previewPush: async id => ipcRenderer.invoke('randolph:preview-push', id),
  approvePush: async input => ipcRenderer.invoke('randolph:approve-push', input),
  checkPush: async id => ipcRenderer.invoke('randolph:check-push', id),
  stopPush: async id => ipcRenderer.invoke('randolph:stop-push', id),
  stopReview: async id => ipcRenderer.invoke('randolph:stop-review', id),
  send: async input => ipcRenderer.invoke('randolph:send', input),
  stop: async id => ipcRenderer.invoke('randolph:stop', id),
  markRead: async id => ipcRenderer.invoke('randolph:mark-read', id),
  onChanged: listener => {
    const callback = (): void => { listener(); };
    ipcRenderer.on('randolph:changed', callback);
    return () => { ipcRenderer.removeListener('randolph:changed', callback); };
  },
};
contextBridge.exposeInMainWorld('randolph', bridge);
