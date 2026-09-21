import { Menu, nativeImage, nativeTheme, Notification, Tray } from 'electron';
import type { AppPreferences, AppSettingsSnapshot, Runtime } from '@randolph/runtime';

export type TrayPolicyHost = {
  /** The single runtime instance; the policy reads active work and the durable event log from it. */
  runtime: Runtime;
  /** Absolute path of the tray/notification icon. */
  iconPath: string;
  /** Bootstrap-owned navigation; the policy never opens or focuses the window itself. */
  showPage: (destination: 'workspace' | 'settings') => void;
  /** Reports whether the main window currently has focus, so focused work stays silent. */
  isWindowFocused: () => boolean;
  /** Bootstrap-owned quit, so the tray item still routes through the shutdown confirmation. */
  requestQuit: () => void;
};

export type TrayPolicy = {
  /** Adopts a settings snapshot: stores preferences, applies the theme, refreshes the tray. */
  applySettings: (settings: AppSettingsSnapshot) => void;
  /** Rebuilds or tears down the tray for the current background preference and work state. */
  update: () => void;
  /** Emits notifications for events newer than the cursor, honoring the notification preferences. */
  notifyChanges: () => void;
  /** Whether background execution is enabled; the bootstrap uses it for close and quit policy. */
  backgroundEnabled: () => boolean;
  /** Removes the tray during shutdown. */
  destroyTray: () => void;
};

export function createTrayPolicy(host: TrayPolicyHost): TrayPolicy {
  const runtime = host.runtime;
  let preferences: AppPreferences | undefined;
  let tray: Tray | undefined;
  let trayActive: boolean | undefined;
  // Existing events are already delivered; only later sequences may raise a notification.
  let notificationCursor = runtime.store.events().at(-1)?.sequence ?? 0;
  function update(): void {
    if (!preferences?.background) {
      tray?.destroy();
      tray = undefined;
      trayActive = undefined;
      return;
    }
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(host.iconPath).resize({ width: 18, height: 18 }));
      tray.on('click', () => {
        host.showPage('workspace');
      });
    }
    const active = runtime.hasActiveWork();
    if (trayActive === active) return;
    trayActive = active;
    tray.setToolTip(active ? 'Randolph — work running' : 'Randolph');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Randolph',
          click: () => {
            host.showPage('workspace');
          },
        },
        {
          label: 'Settings…',
          click: () => {
            host.showPage('settings');
          },
        },
        { type: 'separator' },
        {
          label: 'Stop all work',
          enabled: active,
          click: () => {
            void runtime.stopAll();
          },
        },
        { type: 'separator' },
        { label: 'Quit Randolph', click: () => host.requestQuit() },
      ]),
    );
  }
  function applySettings(settings: AppSettingsSnapshot): void {
    if (settings.error) return;
    preferences = settings.value;
    nativeTheme.themeSource = preferences.theme;
    update();
  }
  function notifyChanges(): void {
    for (const event of runtime.store.events()) {
      if (event.sequence <= notificationCursor) continue;
      notificationCursor = event.sequence;
      if (host.isWindowFocused() || !Notification.isSupported() || !preferences) continue;
      const enabled =
        event.type === 'run.completed'
          ? preferences.notifications.completed
          : [
                'run.failed',
                'run.stop-unconfirmed',
                'verification.failed',
                'verification.stop-unconfirmed',
                'delivery.failed',
              ].includes(event.type)
            ? preferences.notifications.failures
            : event.type === 'verification.completed' && event.data.status === 'passed'
              ? preferences.notifications.approvals
              : false;
      if (!enabled) continue;
      const notification = new Notification({
        title: event.type === 'verification.completed' ? 'Randolph: review ready' : 'Randolph',
        body: event.summary.slice(0, 240),
      });
      notification.on('click', () => {
        host.showPage('workspace');
      });
      notification.show();
    }
  }
  return {
    applySettings,
    update,
    notifyChanges,
    backgroundEnabled: () => preferences?.background ?? false,
    destroyTray: () => {
      tray?.destroy();
      tray = undefined;
    },
  };
}
