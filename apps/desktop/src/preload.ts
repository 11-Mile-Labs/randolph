import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@randolph/runtime/contracts';
const bridge: DesktopBridge = {
  snapshot: async () => ipcRenderer.invoke('randolph:snapshot'),
  harness: async () => ipcRenderer.invoke('randolph:harness'),
  addProject: async () => ipcRenderer.invoke('randolph:add-project'),
  createConversation: async id => ipcRenderer.invoke('randolph:create-conversation', id),
  saveProjectDefaults: async input => ipcRenderer.invoke('randolph:save-project-defaults', input),
  setConversationSelection: async input => ipcRenderer.invoke('randolph:conversation-selection', input),
  setExecutionMode: async input => ipcRenderer.invoke('randolph:execution-mode', input),
  prepareReview: async id => ipcRenderer.invoke('randolph:prepare-review', id),
  verifyReview: async id => ipcRenderer.invoke('randolph:verify-review', id),
  approveReview: async input => ipcRenderer.invoke('randolph:approve-review', input),
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
