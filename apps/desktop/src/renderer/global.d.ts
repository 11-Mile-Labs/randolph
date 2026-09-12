import type { DesktopBridge } from '@randolph/runtime/contracts';

declare global {
  interface Window {
    randolph: DesktopBridge;
  }
}

export {};
