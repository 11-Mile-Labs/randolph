import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@randolph/runtime/contracts';
const bridge: DesktopBridge = {
  snapshot: async () => ipcRenderer.invoke('randolph:snapshot'),
  harness: async () => ipcRenderer.invoke('randolph:harness'),
  addProject: async () => ipcRenderer.invoke('randolph:add-project'),
  createConversation: async id => ipcRenderer.invoke('randolph:create-conversation', id),
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
