import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseHarnessRequest, parseLinkedCheckpoint, parseAppSettings, parseGlobalMemory, parseCheckpoint, parsePushApproval } from './validation.js';
import { parseMemoryCommand, parseLessonRef } from './memory-validation.js';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, net, protocol, session, Tray, type IpcMainInvokeEvent } from 'electron';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Runtime, type AppPreferences, type AppSettingsSnapshot } from '@randolph/runtime';
import { CodexAdapter } from '@randolph/harness-codex';
import { GrokAdapter } from '@randolph/harness-grok';
import { parseChatEvents, parseSend, parseId, parseProjectDefaults, parseConversationSelection, parseMode, parseReviewApproval } from './validation.js';

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
let preferences: AppPreferences | undefined;
let tray: Tray | undefined;
let trayActive: boolean | undefined;
let pendingNavigation: { sequence: number; destination: 'workspace' | 'settings' } | undefined;
let navigationSequence = 0;
let notificationCursor = 0;

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
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (preferences?.background) window?.hide();
    else void shutdown('close');
  });
  window.on('closed', () => { window = undefined; });
  await window.loadURL(page);
}
async function shutdown(reason: 'close' | 'quit' = 'quit'): Promise<void> {
  if (confirming || quitting) return;
  confirming = true;
  try {
    if (runtime?.hasActiveWork()) {
      const closing = reason === 'close';
      const answer = await dialog.showMessageBox({ type: 'warning', title: closing ? 'Close Randolph?' : 'Quit Randolph?', message: closing ? 'Closing will stop active work.' : 'Quit and stop active conversations?', detail: closing ? 'Enable background execution in Settings to keep work running after closing the window.' : 'Work will not restart automatically when you reopen Randolph.', buttons: closing ? ['Cancel', 'Stop work and close', 'Change settings'] : ['Cancel', 'Stop work and quit'], defaultId: 0, cancelId: 0 });
      if (closing && answer.response === 2) { await showPage('settings'); return; }
      if (answer.response !== 1) return;
    }
    await runtime?.close();
    tray?.destroy(); tray = undefined;
    quitting = true; app.quit();
  } catch {
    dialog.showErrorBox('Unable to finish shutdown', 'Run state or process cleanup could not be confirmed. Randolph remains open.');
  } finally { confirming = false; }
}
async function showPage(destination: 'workspace' | 'settings'): Promise<void> {
  if (quitting) return;
  pendingNavigation = { sequence: ++navigationSequence, destination };
  if (!window || window.isDestroyed()) await openWindow();
  window?.show(); window?.focus();
  if (window && !window.webContents.isLoadingMainFrame() && pendingNavigation) window.webContents.send('randolph:navigate', pendingNavigation);
}
function updateTray(): void {
  if (!preferences?.background) { tray?.destroy(); tray = undefined; trayActive = undefined; return; }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(join(rendererRoot, 'randolph.png')).resize({ width: 18, height: 18 }));
    tray.on('click', () => { void showPage('workspace'); });
  }
  const active = runtime?.hasActiveWork() ?? false;
  if (trayActive === active) return;
  trayActive = active;
  tray.setToolTip(active ? 'Randolph — work running' : 'Randolph');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Randolph', click: () => { void showPage('workspace'); } },
    { label: 'Settings…', click: () => { void showPage('settings'); } },
    { type: 'separator' },
    { label: 'Stop all work', enabled: active, click: () => { void runtime?.stopAll(); } },
    { type: 'separator' }, { label: 'Quit Randolph', click: () => app.quit() },
  ]));
}
function applySettings(settings: AppSettingsSnapshot): void {
  if (settings.error) return;
  preferences = settings.value; nativeTheme.themeSource = preferences.theme; updateTray();
}
function notifyChanges(): void {
  for (const event of runtime?.store.events() ?? []) {
    if (event.sequence <= notificationCursor) continue;
    notificationCursor = event.sequence;
    if (window?.isFocused() || !Notification.isSupported() || !preferences) continue;
    const enabled = event.type === 'run.completed' ? preferences.notifications.completed
      : ['run.failed', 'run.stop-unconfirmed', 'verification.failed', 'verification.stop-unconfirmed', 'delivery.failed'].includes(event.type) ? preferences.notifications.failures
        : event.type === 'verification.completed' && event.data.status === 'passed' ? preferences.notifications.approvals : false;
    if (!enabled) continue;
    const notification = new Notification({ title: event.type === 'verification.completed' ? 'Randolph: review ready' : 'Randolph', body: event.summary.slice(0, 240) });
    notification.on('click', () => { void showPage('workspace'); });
    notification.show();
  }
}
app.on('window-all-closed', () => { if (!quitting && !preferences?.background) app.quit(); });
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
if (!app.requestSingleInstanceLock()) { quitting = true; app.quit(); }
else {
  app.on('second-instance', () => { void showPage('workspace'); });
  app.on('activate', () => { if (runtime && !quitting) void showPage('workspace'); });
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
      runtime = new Runtime({ codex: new CodexAdapter(), grok: new GrokAdapter() }, dataRoot);
      notificationCursor = runtime.store.events().at(-1)?.sequence ?? 0;
      applySettings(runtime.appSettings());
      app.dock?.setIcon(join(rendererRoot, 'randolph.png'));
      app.setAboutPanelOptions({ applicationName: 'Randolph', applicationVersion: app.getVersion(), copyright: '11 Mile Labs', iconPath: join(rendererRoot, 'randolph.png') });
      runtime.subscribe(() => {
        if (window && !window.isDestroyed()) window.webContents.send('randolph:changed');
        updateTray(); notifyChanges();
      });
      command('randolph:snapshot', () => runtime!.snapshot());
      command('randolph:chat-events', input => runtime!.chatEvents(parseChatEvents(input)));
      command('randolph:initial-navigation', () => pendingNavigation ?? null);
      command('randolph:ack-navigation', sequence => { if (typeof sequence === 'number' && pendingNavigation?.sequence === sequence) pendingNavigation = undefined; });
      command('randolph:app-settings', () => { const settings = runtime!.appSettings(); applySettings(settings); return settings; });
      command('randolph:save-app-settings', input => { const settings = runtime!.saveAppSettings(parseAppSettings(input)); applySettings(settings); return settings; });
      command('randolph:save-global-memory', input => runtime!.saveGlobalMemory(parseGlobalMemory(input)));
      command('randolph:restart-run', input => runtime!.restartRun(parseLinkedCheckpoint(input)));
      command('randolph:rerun-checkpoint', input => runtime!.rerunFromCheckpoint(parseLinkedCheckpoint(input)));
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
      command('randolph:harness-installations', input => runtime!.harnessInstallations(parseHarnessRequest(input).harness));
      command('randolph:harness', input => { const request = parseHarnessRequest(input); return runtime!.harness(request.projectId, request.executable, request.harness); });
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
        { label: 'Randolph', submenu: [
          { label: 'About Randolph', click: () => app.showAboutPanel() }, { type: 'separator' },
          { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => { void showPage('settings'); } },
          { type: 'separator' }, { role: 'services' }, { type: 'separator' },
          { role: 'hide', label: 'Hide Randolph' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, { role: 'quit', label: 'Quit Randolph' },
        ] },
        { label: 'File', submenu: [{ label: 'Open Workspace', accelerator: 'CommandOrControl+1', click: () => { void showPage('workspace'); } }, { type: 'separator' }, { role: 'close' }] },
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
        { label: 'Work', submenu: [{ label: 'Stop all work', click: () => { void runtime!.stopAll(); } }] },
        { role: 'windowMenu' },
        { role: 'help', submenu: [{ label: 'Open Workspace', click: () => { void showPage('workspace'); } }, { label: 'Application Settings', click: () => { void showPage('settings'); } }] },
      ]));
      await openWindow();
    } catch (error) {
      dialog.showErrorBox('Randolph could not start', error instanceof Error ? error.message : 'Startup failed.');
      quitting = true; app.exit(1);
    }
  }
  void start();
}
