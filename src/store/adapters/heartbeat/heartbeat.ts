import { writeFileAtomic } from '../../../shared/atomicFile';
import { isOurs, type OwnLock } from '../lockState/lockFile';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../lockState/lockTimings';
import { lockLostReason } from '../../lockLost';
import type { Clock } from '../../../shared/clock';
import { errorMessage } from '../../../shared/errors';
import type { Logger } from '../../../shared/telemetry';

export interface HeartbeatOptions {
  clock: Clock;
  logger: Logger;
  /** Default: LOCK_HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
}

export interface Heartbeat {
  /** Fires, and the beats end, at the first beat that finds the lock no longer ours. */
  readonly lost: AbortSignal;
  /** Stops the timer and waits for a beat in flight, so none can write after a release. */
  stop(): Promise<void>;
}

/**
 * Rewrites `heartbeatAt` while the lock is held, so other containers (whose pid they cannot see)
 * can tell a running holder from a dead one. Never throws: a missed beat only matters if the
 * holder stays silent for LOCK_HEARTBEAT_TIMEOUT_MS. A beat that finds the lock taken over or
 * removed fires `lost`, so the run stops; `stop()` does not fire it.
 */
export function startHeartbeat(
  lockPath: string,
  mine: OwnLock,
  options: HeartbeatOptions,
): Heartbeat {
  const { clock, logger } = options;
  const lost = new AbortController();
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const beat = async (): Promise<void> => {
    try {
      if (!(await isOurs(lockPath, mine))) {
        stopped = true;
        clearInterval(timer);
        logger.warn('Run lock is no longer ours (taken over or removed); this run stops', {
          runId: mine.runId,
        });
        lost.abort(lockLostReason());
        return;
      }
      const refreshed: OwnLock = { ...mine, heartbeatAt: clock.now().toISOString() };
      await writeFileAtomic(lockPath, JSON.stringify(refreshed));
    } catch (error) {
      logger.warn('Could not refresh the run lock heartbeat', { error: errorMessage(error) });
    }
  };
  const tick = (): void => {
    // A slow disk skips beats instead of queueing them.
    if (stopped || inFlight) return;
    inFlight = beat().finally(() => {
      inFlight = undefined;
    });
  };

  const timer = setInterval(tick, options.heartbeatIntervalMs ?? LOCK_HEARTBEAT_INTERVAL_MS);
  // Never the reason a process stays alive.
  timer.unref();
  return {
    lost: lost.signal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
