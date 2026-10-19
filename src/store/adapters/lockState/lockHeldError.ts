import { DigestError } from '../../../shared/errors';
import { LOCK_HELD_MESSAGE } from '../../lockHeld';
import type { LockFile } from './lockFile';

/** The error for a live run that holds the lock (or the takeover guard). */
export function lockHeldError(lock: LockFile): DigestError {
  const host = lock.hostname === undefined ? '' : `, host ${lock.hostname}`;
  return new DigestError(
    `${LOCK_HELD_MESSAGE} (pid ${String(lock.pid)}${host}, week ${lock.runId})`,
  );
}
