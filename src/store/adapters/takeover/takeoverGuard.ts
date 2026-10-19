import { rm } from 'node:fs/promises';
import { inspect } from '../lockState/liveness';
import { createLockFile, type OwnLock } from '../lockState/lockFile';
import { lockHeldError } from '../lockState/lockHeldError';
import type { Clock } from '../../../shared/clock';
import type { Logger } from '../../../shared/telemetry';

/** The takeover guard of a lock is the lock's path plus this suffix. */
export const GUARD_SUFFIX = '.takeover';

export function guardPathOf(lockPath: string): string {
  return `${lockPath}${GUARD_SUFFIX}`;
}

/**
 * Serialises takeovers: only one contender at a time may remove a stale lock, otherwise two of
 * them can both inspect it as stale and the second removes the first one's fresh lock.
 * Returns false when an abandoned guard was cleared and the caller should try again.
 */
export async function acquireTakeoverGuard(
  guardPath: string,
  mine: OwnLock,
  options: { clock: Clock; logger: Logger },
): Promise<boolean> {
  if (await createLockFile(guardPath, mine)) return true;

  const guard = await inspect(guardPath, options.clock.now(), mine, 'guard');
  if (guard.kind === 'held') throw lockHeldError(guard.lock);
  if (guard.kind === 'stale') {
    options.logger.warn('Removing abandoned lock takeover guard', { reason: guard.reason });
    await rm(guardPath, { force: true });
  }
  return false;
}
