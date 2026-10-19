import { writeFileAtomic } from '../atomicFile';
import { isOurs, type OwnLock } from '../lockState/lockFile';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../lockState/lockTimings';
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
  /** Stops the timer and waits for a beat in flight, so none can write after a release. */
  stop(): Promise<void>;
}

/**
 * Rewrites `heartbeatAt` while the lock is held, so other containers (whose pid they cannot see)
 * can tell a running holder from a dead one. Never throws: a missed beat only matters if the
 * holder stays silent for LOCK_HEARTBEAT_TIMEOUT_MS.
 */
export function startHeartbeat(
  lockPath: string,
  mine: OwnLock,
  options: HeartbeatOptions,
): Heartbeat {
  const { clock, logger } = options;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const beat = async (): Promise<void> => {
    try {
      if (!(await isOurs(lockPath, mine))) {
        stopped = true;
        clearInterval(timer);
        logger.warn('Run lock is no longer ours (taken over or removed); its heartbeat stops', {
          runId: mine.runId,
        });
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
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
