export interface PushOptions {
  signal?: AbortSignal;
  /** Synchronous authority check, invoked immediately before every Git spawn. */
  assertCurrent?: () => void;
  sshKeyPath?: string;
  /** Explicitly opt in for local bare fixture origins; never accept this through IPC. */
  allowLocalTransport?: boolean;
}
