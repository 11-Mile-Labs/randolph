import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCheckpoint, parsePushApproval } from './validation.js';
import { parseMemoryCommand, parseLessonRef } from './memory-validation.js';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Runtime } from '@randolph/runtime';
import { CodexAdapter } from '@randolph/harness-codex';
import { parseSend, parseId, parseProjectDefaults, parseConversationSelection, parseMode, parseReviewApproval } from './validation.js';

const dataRoot = process.env.RANDOLPH_DATA_DIR ? resolve(process.env.RANDOLPH_DATA_DIR) : join(homedir(), '.randolph');
app.setName('Randolph');
app.setPath('userData', join(dataRoot, 'desktop'));
protocol.registerSchemesAsPrivileged([{ scheme: 'randolph', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), 'renderer');
const page = 'randolph://app/index.html';
let window: BrowserWindow | undefined;
let runtime: Runtime | undefined;
let quitting = false;
let confirming = false;

function assertSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('Untrusted application request.');
}
function command(channel: string, action: (value: unknown) => unknown): void {
  ipcMain.handle(channel, (event, value: unknown) => { assertSender(event); return action(value); });
}
async function openWindow(): Promise<void> {
  window = new BrowserWindow({ width: 1360, height: 900, minWidth: 960, minHeight: 640, title: 'Randolph', backgroundColor: '#f6f5f1', titleBarStyle: 'hiddenInset', webPreferences: { preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => { event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => { event.preventDefault(); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
  window.on('closed', () => { window = undefined; });
  await window.loadURL(page);
}
async function shutdown(): Promise<void> {
  if (confirming || quitting) return;
  confirming = true;
  try {
    if (runtime?.hasActiveWork()) {
      const answer = await dialog.showMessageBox({ type: 'warning', title: 'Quit Randolph?', message: 'Quit and stop active conversations?', detail: 'Work will not restart automatically when you reopen Randolph.', buttons: ['Cancel', 'Stop work and quit'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
    }
    await runtime?.close();
    quitting = true; app.quit();
  } catch {
    dialog.showErrorBox('Unable to finish shutdown', 'Run state or process cleanup could not be confirmed. Randolph remains open.');
  } finally { confirming = false; }
}
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
if (!app.requestSingleInstanceLock()) { quitting = true; app.quit(); }
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  async function start(): Promise<void> {
    try {
      await app.whenReady();
      protocol.handle('randolph', async request => {
        const url = new URL(request.url);
        if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 });
        let path: string;
        try { path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`); }
        catch { return new Response('Invalid request', { status: 400 }); }
        if (!path.startsWith(rendererRoot + sep)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(path).href);
      });
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); });
      session.defaultSession.setPermissionCheckHandler(() => false);
      runtime = new Runtime(new CodexAdapter(), dataRoot);
      runtime.subscribe(() => { if (window && !window.isDestroyed()) window.webContents.send('randolph:changed'); });
      command('randolph:snapshot', () => runtime!.snapshot());
      command('randolph:restore-checkpoint', async input => {
        const checkpoint = parseCheckpoint(input);
        const choice = await dialog.showOpenDialog(window!, { title: 'Choose a folder for the restored checkpoint', message: 'Creates a new folder with retained files and Git history. No agent or delivery action starts.', properties: ['openDirectory', 'createDirectory'] });
        if (choice.canceled || !choice.filePaths[0]) return null;
        return runtime!.restoreCheckpoint(checkpoint, join(realpathSync(choice.filePaths[0]), `randolph-recovery-${randomUUID()}`));
      });
      command('randolph:memory', id => runtime!.memorySnapshot(parseId(id)));
      command('randolph:memory-command', input => runtime!.memoryCommand(parseMemoryCommand(input)));
      command('randolph:memory-history', input => {
        if (!input || typeof input !== 'object' || !('projectId' in input) || !('reference' in input)) throw new Error('Invalid memory history request.');
        return runtime!.memoryHistory(parseId(input.projectId), parseLessonRef(input.reference));
      });
      command('randolph:harness', () => runtime!.harness());
      command('randolph:add-project', async () => {
        const choice = await dialog.showOpenDialog(window!, { title: 'Choose a project folder', properties: ['openDirectory'] });
        if (choice.canceled || !choice.filePaths[0]) return null;
        return runtime!.addProject(choice.filePaths[0]);
      });
      command('randolph:create-conversation', id => runtime!.createConversation(parseId(id)));
      command('randolph:save-project-defaults', input => runtime!.saveProjectDefaults(parseProjectDefaults(input)));
      command('randolph:conversation-selection', input => runtime!.setConversationSelection(parseConversationSelection(input)));
      command('randolph:execution-mode', input => runtime!.setExecutionMode(parseMode(input)));
      command('randolph:integrate', id => runtime!.integrateConversation(parseId(id)));
      command('randolph:confirm-integration', id => runtime!.confirmIntegration(parseId(id)));
      command('randolph:prepare-review', id => runtime!.prepareReview(parseId(id)));
      command('randolph:verify-review', id => runtime!.verifyReview(parseId(id)));
      command('randolph:approve-review', input => runtime!.approveReview(parseReviewApproval(input)));
      command('randolph:preview-push', id => runtime!.previewPush(parseId(id)));
      command('randolph:approve-push', input => runtime!.approvePush(parsePushApproval(input)));
      command('randolph:check-push', id => runtime!.checkPush(parseId(id)));
      command('randolph:stop-push', id => runtime!.stopPush(parseId(id)));
      command('randolph:stop-review', id => runtime!.stopReview(parseId(id)));
      command('randolph:send', input => runtime!.send(parseSend(input)));
      command('randolph:stop', id => runtime!.stop(parseId(id)));
      command('randolph:mark-read', id => runtime!.markRead(parseId(id)));
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'Randolph', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
        { role: 'editMenu' },
        { label: 'Work', submenu: [{ label: 'Stop all work', click: () => { void runtime!.stopAll(); } }] },
        { role: 'windowMenu' },
      ]));
      await openWindow();
    } catch (error) {
      dialog.showErrorBox('Randolph could not start', error instanceof Error ? error.message : 'Startup failed.');
      quitting = true; app.exit(1);
    }
  }
  void start();
}
