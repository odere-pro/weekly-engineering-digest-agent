/**
 * The reason `RunLock.lost` fires with. A run that lost its lock fails with it, as `Run aborted
 * during the <step> step: <this>`, so it reaches run output and the failure note: it names the
 * loss only. Every `RunStore` gives the same reason.
 */
export const LOCK_LOST_MESSAGE =
  'this run lost its lock (another run took it over, or the lock file was removed)';

/** The reason to fire `RunLock.lost` with. */
export function lockLostReason(): Error {
  return new Error(LOCK_LOST_MESSAGE);
}
