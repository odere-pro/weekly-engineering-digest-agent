import { isErrnoException, readTextIfExists } from '../../../shared/atomicFile';
import { parseLockFile, type LockFile, type OwnLock } from './lockFile';
import {
  LOCK_HEARTBEAT_TIMEOUT_MS,
  LOCK_MAX_AGE_MS,
  TAKEOVER_GUARD_MAX_AGE_MS,
} from './lockTimings';

/** The run lock itself, or the short-lived guard that serialises takeovers of it. */
export type LockKind = 'lock' | 'guard';

export type LockState =
  | { kind: 'free' }
  | { kind: 'held'; lock: LockFile }
  | { kind: 'stale'; reason: string; lock?: LockFile };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return isErrnoException(error, 'EPERM');
  }
}

function ageMs(now: Date, timestamp: string): number {
  return now.getTime() - Date.parse(timestamp);
}

/** True when `lock`'s pid names a process this one can see (or could, before it died). */
function sharesPids(lock: LockFile, me: OwnLock): boolean {
  // A legacy lock names no host or namespace, so it gets the pid check it always had.
  const sameHost = lock.hostname === undefined || lock.hostname === me.hostname;
  const sameNamespace =
    lock.pidNamespace === undefined ||
    me.pidNamespace === undefined ||
    lock.pidNamespace === me.pidNamespace;
  return sameHost && sameNamespace;
}

/** Why `lock` is abandoned, or undefined when its holder may still be running. */
export function staleReason(
  lock: LockFile,
  now: Date,
  me: OwnLock,
  kind: LockKind,
): string | undefined {
  if (sharesPids(lock, me)) {
    if (!isPidAlive(lock.pid)) return 'process is not running';
    if (lock.pid === me.pid && lock.token !== undefined && lock.token !== me.token) {
      return 'lock was left by a previous process with this pid';
    }
  }
  // Only a lock is kept alive by heartbeats; a guard lives for milliseconds. A heartbeat far in
  // the future (a clock that was ahead) is as untrustworthy as an old one.
  if (kind === 'lock' && lock.heartbeatAt !== undefined) {
    return Math.abs(ageMs(now, lock.heartbeatAt)) >= LOCK_HEARTBEAT_TIMEOUT_MS
      ? 'heartbeat is stale'
      : undefined;
  }
  const maxAgeMs = kind === 'guard' ? TAKEOVER_GUARD_MAX_AGE_MS : LOCK_MAX_AGE_MS;
  return ageMs(now, lock.startedAt) >= maxAgeMs ? 'lock is too old' : undefined;
}

/** Reads the lock file at `path` and says whether it is absent, live or abandoned. */
export async function inspect(
  path: string,
  now: Date,
  me: OwnLock,
  kind: LockKind,
): Promise<LockState> {
  const text = await readTextIfExists(path);
  if (text === undefined) return { kind: 'free' };

  const lock = parseLockFile(text);
  if (lock === undefined) return { kind: 'stale', reason: 'lock file is unreadable' };
  const reason = staleReason(lock, now, me, kind);
  return reason === undefined ? { kind: 'held', lock } : { kind: 'stale', reason, lock };
}
