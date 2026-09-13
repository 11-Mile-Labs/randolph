/** Failed synchronous stages cannot claim cleanup when a subprocess timed out or lost its exit proof. */
export function workspaceCleanupConfirmed(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === 'object'; cause = (cause as { cause?: unknown }).cause) {
    if (seen.has(cause)) return false;
    seen.add(cause);
    const value = cause as { name?: string; code?: string; signal?: unknown; pid?: number; status?: number | null; cleanupVerified?: boolean; cleanupConfirmed?: boolean };
    if (value.name === 'CleanupUnconfirmedError' || value.cleanupVerified === false || value.cleanupConfirmed === false || value.signal || ['ETIMEDOUT', 'ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(value.code ?? '') || value.pid && value.status === null) return false;
  }
  return true;
}
