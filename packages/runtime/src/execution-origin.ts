import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export type ExecutionOrigin = { version: 1; hostIdHash: string; bootSessionId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ORIGIN_PREFIX = 'randolph.execution-origin.v1\0';
const SYSTEM_TIMEOUT_MS = 1_000;
const SYSTEM_MAX_BUFFER = 4_096;

function uuid(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return UUID.test(normalized) ? normalized : undefined;
}

function platformUuid(output: string): string | undefined {
  const matches = [...output.matchAll(/^\s*(?:\|\s*)*"IOPlatformUUID"\s*=\s*"([0-9a-f-]+)"\s*$/gim)];
  if (matches.length !== 1) return undefined;
  return uuid(matches[0][1]);
}

function validOrigin(value: unknown): value is ExecutionOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 3 && keys.includes('version') && keys.includes('hostIdHash') && keys.includes('bootSessionId')
    && record.version === 1 && typeof record.hostIdHash === 'string' && SHA256.test(record.hostIdHash)
    && typeof record.bootSessionId === 'string' && UUID.test(record.bootSessionId);
}

export function parseExecutionOrigin(platform: string, ioregOutput: string, bootSessionOutput: string): ExecutionOrigin | undefined {
  if (platform !== 'darwin') return undefined;
  const hardwareId = platformUuid(ioregOutput);
  const bootSessionId = uuid(bootSessionOutput);
  if (!hardwareId || !bootSessionId) return undefined;
  return {
    version: 1,
    hostIdHash: createHash('sha256').update(ORIGIN_PREFIX).update(hardwareId).digest('hex'),
    bootSessionId,
  };
}

export function readExecutionOrigin(): ExecutionOrigin | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const ioregOutput = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice', '-k', 'IOPlatformUUID'], {
      encoding: 'utf8', timeout: SYSTEM_TIMEOUT_MS, maxBuffer: SYSTEM_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bootSessionOutput = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8', timeout: SYSTEM_TIMEOUT_MS, maxBuffer: SYSTEM_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseExecutionOrigin(process.platform, ioregOutput, bootSessionOutput);
  } catch {
    return undefined;
  }
}

export function cleanupReconciliationReason(recorded: unknown, current: unknown): string | null {
  if (!validOrigin(recorded)) return 'Cleanup cannot be reconciled because the original Mac execution record is missing or malformed.';
  if (current === undefined) return 'Current execution origin is unavailable.';
  if (!validOrigin(current)) return 'Cleanup cannot be reconciled because the current Mac execution record is malformed.';
  if (recorded.hostIdHash !== current.hostIdHash) return 'Cleanup requires evidence from the original Mac.';
  if (recorded.bootSessionId === current.bootSessionId) return 'Restart the original Mac before reconciling cleanup.';
  return null;
}
