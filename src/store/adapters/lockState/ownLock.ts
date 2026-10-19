import { randomUUID } from 'node:crypto';
import { readlink } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import type { Clock } from '../../../shared/clock';
import type { OwnLock } from './lockFile';

/** Tells this process from an earlier one that had the same pid (PID 1 after a container restart). */
const PROCESS_TOKEN = randomUUID();

const PID_NAMESPACE_LINK = '/proc/self/ns/pid';

export interface OwnLockOptions {
  runId: string;
  clock: Clock;
  /** Names this machine in the lock. Default: os.hostname() (the container id in Docker). */
  hostname?: string;
  /** Names this PID namespace in the lock. Default: read from /proc (Linux), else none. */
  pidNamespace?: string;
}

/** Namespace id of this process, undefined where /proc has none (macOS, Windows). */
export async function readPidNamespace(): Promise<string | undefined> {
  try {
    return await readlink(PID_NAMESPACE_LINK);
  } catch {
    return undefined;
  }
}

/** The lock this process would write for `runId`, with its first heartbeat set to now. */
export async function buildOwnLock(options: OwnLockOptions): Promise<OwnLock> {
  const startedAt = options.clock.now().toISOString();
  return {
    pid: process.pid,
    runId: options.runId,
    startedAt,
    // An empty name would make our own lock look unreadable (the schema wants a name).
    hostname: options.hostname ?? (osHostname() || 'unknown'),
    token: PROCESS_TOKEN,
    pidNamespace: options.pidNamespace ?? (await readPidNamespace()),
    heartbeatAt: startedAt,
  };
}
