import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLockHandle } from './heartbeat/lockHandle';
import { inspect } from './lockState/liveness';
import { createLockFile } from './lockState/lockFile';
import { lockHeldError } from './lockState/lockHeldError';
import { buildOwnLock } from './lockState/ownLock';
import { sweepOrphanedTempFiles } from './takeover/orphanSweep';
import { takeOverStaleLock } from './takeover/takeover';
import type { RunLock } from '../RunStore';
import type { Clock } from '../../shared/clock';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';

const MAX_ATTEMPTS = 3;

export interface AcquireLockOptions {
  lockPath: string;
  runId: string;
  clock: Clock;
  logger: Logger;
  /** Names this machine in the lock. Default: os.hostname() (the container id in Docker). */
  hostname?: string;
  /** Names this PID namespace in the lock. Default: read from /proc (Linux), else none. */
  pidNamespace?: string;
  /** Default: LOCK_HEARTBEAT_INTERVAL_MS (`lockState/lockTimings`). */
  heartbeatIntervalMs?: number;
}

/**
 * Takes the single-run lock. Throws DigestError (exit 1) when a live run holds it; an abandoned
 * lock is taken over with a warning. While held, the lock's `heartbeatAt` is refreshed every
 * LOCK_HEARTBEAT_INTERVAL_MS until `release()`.
 *
 * A lock is abandoned when its heartbeat is older than LOCK_HEARTBEAT_TIMEOUT_MS, when it names
 * this host and its pid is dead, when it names this host and pid but another process token (an
 * earlier incarnation, such as PID 1 after a container restart), or when it cannot be read. A
 * lock from another host with a fresh heartbeat is live whatever its pid looks like from here.
 * A lock without a heartbeat (older versions) is also abandoned after LOCK_MAX_AGE_MS.
 * The timings are in `lockState/lockTimings.ts`.
 *
 * Temp files that a killed run left next to the lock are removed once they are
 * ORPHANED_TEMP_MAX_AGE_MS old, whether or not the lock can be taken.
 *
 * Known limits (docs/runbooks/debug/stuck-lock.md has the operator's view):
 * - Plain files give no OS-level lock, so the check-then-remove steps of a takeover (and of
 *   release and of a heartbeat) leave a window of a few syscalls. It only matters when a run
 *   crashed or was frozen (a suspended laptop, a paused VM) for longer than the guard/lock expiry
 *   while another run starts at the same moment.
 * - A holder that resumes after a stall longer than LOCK_HEARTBEAT_TIMEOUT_MS may find its lock
 *   taken over. It notices at its next beat and stops beating, but its run carries on, so two
 *   runs can overlap.
 * - The heartbeat comes from the process's event loop, not from the run's progress: a run that
 *   hangs while the process stays alive keeps its lock for as long as it hangs.
 * - Creating the lock needs hard links (`link`); a file system without them fails with an
 *   errno such as EPERM or ENOTSUP instead of a DigestError.
 */
export async function acquireRunLock(options: AcquireLockOptions): Promise<RunLock> {
  const { lockPath, runId, clock } = options;
  await mkdir(dirname(lockPath), { recursive: true });
  await sweepOrphanedTempFiles(options);
  const mine = await buildOwnLock({
    runId,
    clock,
    hostname: options.hostname,
    pidNamespace: options.pidNamespace,
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await createLockFile(lockPath, mine)) return createLockHandle(lockPath, mine, options);

    const state = await inspect(lockPath, clock.now(), mine, 'lock');
    if (state.kind === 'held') throw lockHeldError(state.lock);
    if (state.kind === 'stale' && (await takeOverStaleLock(mine, options))) {
      return createLockHandle(lockPath, mine, options);
    }
  }
  throw new DigestError('Could not take the run lock: another run is starting');
}
