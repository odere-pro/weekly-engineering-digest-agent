import { basename, dirname } from 'node:path';
import { removeStaleTempFiles } from '../atomicFile';
import { ORPHANED_TEMP_MAX_AGE_MS } from '../lockState/lockTimings';
import { GUARD_SUFFIX } from './takeoverGuard';
import type { Clock } from '../../../shared/clock';
import { errorMessage } from '../../../shared/errors';
import type { Logger } from '../../../shared/telemetry';

export interface OrphanSweepOptions {
  lockPath: string;
  clock: Clock;
  logger: Logger;
}

/**
 * Removes the temp files that a killed run left next to the lock and its takeover guard
 * (`digest.lock.<pid>.<uuid>.tmp`). Housekeeping only: a failure is logged, never raised, so it
 * can not keep a run from starting.
 */
export async function sweepOrphanedTempFiles(options: OrphanSweepOptions): Promise<void> {
  const { lockPath, clock, logger } = options;
  const lockName = basename(lockPath);
  try {
    const { removed, failed } = await removeStaleTempFiles(
      dirname(lockPath),
      [lockName, `${lockName}${GUARD_SUFFIX}`],
      { maxAgeMs: ORPHANED_TEMP_MAX_AGE_MS, now: clock.now() },
    );
    if (removed.length > 0) logger.warn('Removed orphaned run lock temp files', { files: removed });
    if (failed.length > 0) logger.warn('Could not remove orphaned run lock temp files', { failed });
  } catch (error) {
    logger.warn('Could not sweep orphaned run lock temp files', { error: errorMessage(error) });
  }
}
