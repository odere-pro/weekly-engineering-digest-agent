import { rm } from 'node:fs/promises';
import { startHeartbeat, type HeartbeatOptions } from './heartbeat';
import { isOurs, type OwnLock } from '../lockState/lockFile';
import type { RunLock } from '../../RunStore';

/**
 * The `RunLock` of a lock we just created: starts its heartbeat, whose `lost` it hands out, and on
 * `release()` stops the heartbeat and removes the file. Release is safe to repeat and never
 * removes a lock that another run took over.
 */
export function createLockHandle(
  lockPath: string,
  mine: OwnLock,
  options: HeartbeatOptions,
): RunLock {
  const heartbeat = startHeartbeat(lockPath, mine, options);
  let released = false;
  return {
    lost: heartbeat.lost,
    async release() {
      if (released) return;
      await heartbeat.stop();
      // Leave a lock alone when another run took it over after we were presumed dead.
      if (await isOurs(lockPath, mine)) await rm(lockPath, { force: true });
      // Only after success, so a failed release can be retried.
      released = true;
    },
  };
}
