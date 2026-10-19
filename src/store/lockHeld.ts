import { DigestError } from '../shared/errors';

/**
 * What every "the lock is taken" error starts with. Callers tell a held lock from a real failure
 * by this text, through `isLockHeldError`. Change it only together with the operator's page,
 * docs/runbooks/debug/stuck-lock.md.
 */
export const LOCK_HELD_MESSAGE = 'Another run is in progress';

/** True for the error `RunStore.acquireLock` throws when another run holds the lock. */
export function isLockHeldError(error: unknown): error is DigestError {
  return error instanceof DigestError && error.message.startsWith(LOCK_HELD_MESSAGE);
}
