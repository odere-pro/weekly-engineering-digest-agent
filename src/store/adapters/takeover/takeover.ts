import { rm } from 'node:fs/promises';
import { acquireTakeoverGuard, guardPathOf } from './takeoverGuard';
import { inspect } from '../lockState/liveness';
import { createLockFile, isOurs, type OwnLock } from '../lockState/lockFile';
import { lockHeldError } from '../lockState/lockHeldError';
import type { Clock } from '../../../shared/clock';
import type { Logger } from '../../../shared/telemetry';

export interface TakeoverOptions {
  lockPath: string;
  clock: Clock;
  logger: Logger;
}

/**
 * Replaces a stale lock with ours. Returns false when someone else got there first.
 * The guard is re-checked before each destructive step: another run may have broken it as
 * abandoned (a crash, or us frozen for over 30 s) and now holds a guard of its own.
 */
export async function takeOverStaleLock(mine: OwnLock, options: TakeoverOptions): Promise<boolean> {
  const { lockPath, clock, logger } = options;
  const guardPath = guardPathOf(lockPath);
  if (!(await acquireTakeoverGuard(guardPath, mine, options))) return false;

  try {
    // Look again under the guard: another run may have replaced the stale lock meanwhile.
    const state = await inspect(lockPath, clock.now(), mine, 'lock');
    if (state.kind === 'held') throw lockHeldError(state.lock);
    if (state.kind === 'stale') {
      if (!(await isOurs(guardPath, mine))) return false;
      logger.warn('Taking over stale run lock', { reason: state.reason, previous: state.lock });
      await rm(lockPath, { force: true });
    }
    return await createLockFile(lockPath, mine);
  } finally {
    if (await isOurs(guardPath, mine)) await rm(guardPath, { force: true });
  }
}
