import { DigestError } from '../../shared/errors';

/**
 * What the error starts with that `acquireRunLock` (`store/adapters/runLock.ts`) throws after
 * three lost races for the lock file: "Could not take the run lock: another run is starting".
 * Another run is taking the lock at that moment, so it is retried like a held lock. The text
 * lives in the adapter; `lockMiss.test.ts` fails when it changes there.
 */
export const LOCK_MISS_MESSAGE = 'Could not take the run lock';

/** True for the error `acquireRunLock` throws when it lost every race for the lock file. */
export function isLockMissError(error: unknown): error is DigestError {
  return error instanceof DigestError && error.message.startsWith(LOCK_MISS_MESSAGE);
}
