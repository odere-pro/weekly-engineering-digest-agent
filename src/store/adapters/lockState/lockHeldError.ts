import { DigestError } from '../../../shared/errors';
import type { LockFile } from './lockFile';

/**
 * What every "the lock is taken" error starts with. Callers tell a held lock from a real failure
 * by this text, through `isLockHeldError`. Change it only together with the operator's page,
 * docs/runbooks/debug/stuck-lock.md.
 */
export const LOCK_HELD_MESSAGE = 'Another run is in progress';

/** The error for a live run that holds the lock (or the takeover guard). */
export function lockHeldError(lock: LockFile): DigestError {
  const host = lock.hostname === undefined ? '' : `, host ${lock.hostname}`;
  return new DigestError(
    `${LOCK_HELD_MESSAGE} (pid ${String(lock.pid)}${host}, week ${lock.runId})`,
  );
}

/** True for the error `RunStore.acquireLock` throws when another run holds the lock. */
export function isLockHeldError(error: unknown): error is DigestError {
  return error instanceof DigestError && error.message.startsWith(LOCK_HELD_MESSAGE);
}
