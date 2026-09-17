import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseAppSettings } from './validation.js';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Runtime } from '@randolph/runtime';
import { CodexAdapter } from '@randolph/harness-codex';
import { GrokAdapter } from '@randolph/harness-grok';
import { registerDomainCommands } from './main-ipc.js';
import { createTrayPolicy, type TrayPolicy } from './main-tray.js';

const dataRoot = process.env.RANDOLPH_DATA_DIR
  ? resolve(process.env.RANDOLPH_DATA_DIR)
  : join(homedir(), '.randolph');
app.setName('Randolph');
app.setPath('userData', join(dataRoot, 'desktop'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'randolph', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), 'renderer');
const page = 'randolph://app/index.html';
let window: BrowserWindow | undefined;
let runtime: Runtime | undefined;
let quitting = false;
let confirming = false;
let trayPolicy: TrayPolicy | undefined;
let pendingNavigation: { sequence: number; destination: 'workspace' | 'settings' } | undefined;
let navigationSequence = 0;

function assertSender(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== page
  )
    throw new Error('Untrusted application request.');
}
function command(channel: string, action: (value: unknown) => unknown): void {
  ipcMain.handle(channel, (event, value: unknown) => {
    assertSender(event);
    return action(value);
  });
}
async function openWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Randolph',
    backgroundColor: '#f6f5f1',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (trayPolicy?.backgroundEnabled()) window?.hide();
    else void shutdown('close');
  });
  window.on('closed', () => {
    window = undefined;
  });
  await window.loadURL(page);
}
async function shutdown(reason: 'close' | 'quit' = 'quit'): Promise<void> {
  if (confirming || quitting) return;
  confirming = true;
  try {
    if (runtime?.hasActiveWork({ includeDiscovery: false })) {
      const closing = reason === 'close';
      const answer = await dialog.showMessageBox({
        type: 'warning',
        title: closing ? 'Close Randolph?' : 'Quit Randolph?',
        message: closing ? 'Closing will stop active work.' : 'Quit and stop active conversations?',
        detail: closing
          ? 'Enable background execution in Settings to keep work running after closing the window.'
          : 'Work will not restart automatically when you reopen Randolph.',
        buttons: closing
          ? ['Cancel', 'Stop work and close', 'Change settings']
          : ['Cancel', 'Stop work and quit'],
        defaultId: 0,
        cancelId: 0,
      });
      if (closing && answer.response === 2) {
        await showPage('settings');
        return;
      }
      if (answer.response !== 1) return;
    }
    await runtime?.close();
    trayPolicy?.destroyTray();
    quitting = true;
    app.quit();
  } catch {
    dialog.showErrorBox(
      'Unable to finish shutdown',
      'Run state or process cleanup could not be confirmed. Randolph remains open.',
    );
  } finally {
    confirming = false;
  }
}
async function showPage(destination: 'workspace' | 'settings'): Promise<void> {
  if (quitting) return;
  pendingNavigation = { sequence: ++navigationSequence, destination };
  if (!window || window.isDestroyed()) await openWindow();
  window?.show();
  window?.focus();
  if (window && !window.webContents.isLoadingMainFrame() && pendingNavigation)
    window.webContents.send('randolph:navigate', pendingNavigation);
}
async function chooseRestoreDirectory(): Promise<string | null> {
  const choice = await dialog.showOpenDialog(window!, {
    title: 'Choose a folder for the restored checkpoint',
    message:
      'Creates a new folder with retained files and Git history. No agent or delivery action starts.',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  return join(realpathSync(choice.filePaths[0]), `randolph-recovery-${randomUUID()}`);
}
async function chooseProjectDirectory(): Promise<string | null> {
  const choice = await dialog.showOpenDialog(window!, {
    title: 'Choose a project folder',
    properties: ['openDirectory'],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  return choice.filePaths[0];
}
app.on('window-all-closed', () => {
  if (!quitting && !trayPolicy?.backgroundEnabled()) app.quit();
});
app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault();
    void shutdown();
  }
});
if (!app.requestSingleInstanceLock()) {
  quitting = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    void showPage('workspace');
  });
  app.on('activate', () => {
    if (runtime && !quitting) void showPage('workspace');
  });
  async function start(): Promise<void> {
    try {
      await app.whenReady();
      protocol.handle('randolph', async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== 'app' || request.method !== 'GET')
          return new Response('Not found', { status: 404 });
        let path: string;
        try {
          path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`);
        } catch {
          return new Response('Invalid request', { status: 400 });
        }
        if (!path.startsWith(rendererRoot + sep)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(path).href);
      });
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });
      session.defaultSession.setPermissionCheckHandler(() => false);
      runtime = new Runtime({ codex: new CodexAdapter(), grok: new GrokAdapter() }, dataRoot);
      const policy = createTrayPolicy({
        runtime,
        iconPath: join(rendererRoot, 'randolph.png'),
        showPage: (destination) => {
          void showPage(destination);
        },
        isWindowFocused: () => window?.isFocused() ?? false,
        // The before-quit hook routes this back through shutdown's cleanup confirmation.
        requestQuit: () => app.quit(),
      });
      trayPolicy = policy;
      policy.applySettings(runtime.appSettings());
      app.dock?.setIcon(join(rendererRoot, 'randolph.png'));
      app.setAboutPanelOptions({
        applicationName: 'Randolph',
        applicationVersion: app.getVersion(),
        copyright: '11 Mile Labs',
        iconPath: join(rendererRoot, 'randolph.png'),
      });
      runtime.subscribe(() => {
        if (window && !window.isDestroyed()) window.webContents.send('randolph:changed');
        policy.update();
        policy.notifyChanges();
      });
      // Handlers register only after the runtime exists. The bootstrap keeps the channels that
      // read or write its own navigation and tray state; every other domain goes through the
      // same guarded registrar in main-ipc.ts.
      command('randolph:snapshot', () => runtime!.snapshot());
      command('randolph:initial-navigation', () => pendingNavigation ?? null);
      command('randolph:ack-navigation', (sequence) => {
        if (typeof sequence === 'number' && pendingNavigation?.sequence === sequence)
          pendingNavigation = undefined;
      });
      command('randolph:app-settings', () => {
        const settings = runtime!.appSettings();
        policy.applySettings(settings);
        return settings;
      });
      command('randolph:save-app-settings', (input) => {
        const settings = runtime!.saveAppSettings(parseAppSettings(input));
        policy.applySettings(settings);
        return settings;
      });
      registerDomainCommands(runtime, {
        command,
        chooseRestoreDirectory,
        chooseProjectDirectory,
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Randolph',
            submenu: [
              { label: 'About Randolph', click: () => app.showAboutPanel() },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CommandOrControl+,',
                click: () => {
                  void showPage('settings');
                },
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: 'Hide Randolph' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Quit Randolph' },
            ],
          },
          {
            label: 'File',
            submenu: [
              {
                label: 'Open Workspace',
                accelerator: 'CommandOrControl+1',
                click: () => {
                  void showPage('workspace');
                },
              },
              { type: 'separator' },
              { role: 'close' },
            ],
          },
          { role: 'editMenu' },
          {
            label: 'View',
            submenu: [
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { type: 'separator' },
              { role: 'togglefullscreen' },
            ],
          },
          {
            label: 'Work',
            submenu: [
              {
                label: 'Stop all work',
                click: () => {
                  void runtime!.stopAll();
                },
              },
            ],
          },
          { role: 'windowMenu' },
          {
            role: 'help',
            submenu: [
              {
                label: 'Open Workspace',
                click: () => {
                  void showPage('workspace');
                },
              },
              {
                label: 'Application Settings',
                click: () => {
                  void showPage('settings');
                },
              },
            ],
          },
        ]),
      );
      await openWindow();
    } catch (error) {
      dialog.showErrorBox(
        'Randolph could not start',
        error instanceof Error ? error.message : 'Startup failed.',
      );
      quitting = true;
      app.exit(1);
    }
  }
  void start();
}
