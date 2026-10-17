import { randomUUID } from 'node:crypto';
import { mkdir, readlink, rm } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type { RunLock } from '../../ports/RunStore.js';
import type { Clock } from '../../shared/clock.js';
import { DigestError, errorMessage } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';
import {
  createFileExclusive,
  isErrnoException,
  readTextIfExists,
  removeStaleTempFiles,
  writeFileAtomic,
} from './atomicFile.js';

/** A lock without a heartbeat (written by an older version) this old is presumed abandoned. */
export const LOCK_MAX_AGE_MS = 6 * 3_600_000;
/** A takeover is over in milliseconds; a guard this old was left behind by a crashed run. */
export const TAKEOVER_GUARD_MAX_AGE_MS = 30_000;
/** How often the holder of a lock proves it is alive. */
export const LOCK_HEARTBEAT_INTERVAL_MS = 60_000;
/** A lock whose last heartbeat is this old is presumed abandoned, on any host. */
export const LOCK_HEARTBEAT_TIMEOUT_MS = 5 * 60_000;
/**
 * A lock temp file this old was left by a run that died while writing it. A live writer needs
 * milliseconds. A writer that stalls for longer than this, or a clock that is this far from the
 * file system's, loses its temp file, and the run fails with a plain ENOENT from `link`.
 */
export const ORPHANED_TEMP_MAX_AGE_MS = 10 * 60_000;

const MAX_ATTEMPTS = 3;
const GUARD_SUFFIX = '.takeover';

/** Tells this process from an earlier one that had the same pid (PID 1 after a container restart). */
const PROCESS_TOKEN = randomUUID();

const PID_NAMESPACE_LINK = '/proc/self/ns/pid';

/**
 * `hostname`, `token`, `pidNamespace` and `heartbeatAt` are missing in locks written by older
 * versions. A pid only means something where it was written, so a lock names its host (in Docker
 * the container id: a one-shot `docker compose run` has a different one than `serve`) and, on
 * Linux, its PID namespace (two containers that pin the same hostname still have their own pids).
 */
const LockFileSchema = z.object({
  pid: z.number().int().positive(),
  runId: z.string(),
  startedAt: z.iso.datetime({ offset: true }),
  hostname: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  pidNamespace: z.string().min(1).optional(),
  heartbeatAt: z.iso.datetime({ offset: true }).optional(),
});
type LockFile = z.infer<typeof LockFileSchema>;
/** A lock this process writes: always complete. */
type OwnLock = LockFile & { hostname: string; token: string; heartbeatAt: string };

type LockKind = 'lock' | 'guard';
type LockState =
  | { kind: 'free' }
  | { kind: 'held'; lock: LockFile }
  | { kind: 'stale'; reason: string; lock?: LockFile };

export interface AcquireLockOptions {
  lockPath: string;
  runId: string;
  clock: Clock;
  logger: Logger;
  /** Names this machine in the lock. Default: os.hostname() (the container id in Docker). */
  hostname?: string;
  /** Names this PID namespace in the lock. Default: read from /proc (Linux), else none. */
  pidNamespace?: string;
  /** Default: LOCK_HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return isErrnoException(error, 'EPERM');
  }
}

function parseLockFile(text: string): LockFile | undefined {
  try {
    const parsed = LockFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function ageMs(now: Date, timestamp: string): number {
  return now.getTime() - Date.parse(timestamp);
}

/** True when `lock`'s pid names a process this one can see (or could, before it died). */
function sharesPids(lock: LockFile, me: OwnLock): boolean {
  // A legacy lock names no host or namespace, so it gets the pid check it always had.
  const sameHost = lock.hostname === undefined || lock.hostname === me.hostname;
  const sameNamespace =
    lock.pidNamespace === undefined ||
    me.pidNamespace === undefined ||
    lock.pidNamespace === me.pidNamespace;
  return sameHost && sameNamespace;
}

/** Namespace id of this process, undefined where /proc has none (macOS, Windows). */
async function readPidNamespace(): Promise<string | undefined> {
  try {
    return await readlink(PID_NAMESPACE_LINK);
  } catch {
    return undefined;
  }
}

/** Why `lock` is abandoned, or undefined when its holder may still be running. */
function staleReason(lock: LockFile, now: Date, me: OwnLock, kind: LockKind): string | undefined {
  if (sharesPids(lock, me)) {
    if (!isPidAlive(lock.pid)) return 'process is not running';
    if (lock.pid === me.pid && lock.token !== undefined && lock.token !== me.token) {
      return 'lock was left by a previous process with this pid';
    }
  }
  // Only a lock is kept alive by heartbeats; a guard lives for milliseconds. A heartbeat far in
  // the future (a clock that was ahead) is as untrustworthy as an old one.
  if (kind === 'lock' && lock.heartbeatAt !== undefined) {
    return Math.abs(ageMs(now, lock.heartbeatAt)) >= LOCK_HEARTBEAT_TIMEOUT_MS
      ? 'heartbeat is stale'
      : undefined;
  }
  const maxAgeMs = kind === 'guard' ? TAKEOVER_GUARD_MAX_AGE_MS : LOCK_MAX_AGE_MS;
  return ageMs(now, lock.startedAt) >= maxAgeMs ? 'lock is too old' : undefined;
}

async function inspect(path: string, now: Date, me: OwnLock, kind: LockKind): Promise<LockState> {
  const text = await readTextIfExists(path);
  if (text === undefined) return { kind: 'free' };

  const lock = parseLockFile(text);
  if (lock === undefined) return { kind: 'stale', reason: 'lock file is unreadable' };
  const reason = staleReason(lock, now, me, kind);
  return reason === undefined ? { kind: 'held', lock } : { kind: 'stale', reason, lock };
}

function inProgress(lock: LockFile): DigestError {
  const host = lock.hostname === undefined ? '' : `, host ${lock.hostname}`;
  return new DigestError(
    `Another run is in progress (pid ${String(lock.pid)}${host}, week ${lock.runId})`,
  );
}

/** The same lock, ignoring heartbeats. */
function sameLock(a: LockFile, b: LockFile): boolean {
  return (
    a.pid === b.pid && a.runId === b.runId && a.startedAt === b.startedAt && a.token === b.token
  );
}

function create(path: string, lock: OwnLock): Promise<boolean> {
  return createFileExclusive(path, JSON.stringify(lock));
}

/** True when the file at `path` is the one we created (same pid, token, run and start time). */
async function isOurs(path: string, mine: OwnLock): Promise<boolean> {
  const text = await readTextIfExists(path);
  const current = text === undefined ? undefined : parseLockFile(text);
  return current !== undefined && sameLock(current, mine);
}

interface Heartbeat {
  /** Stops the timer and waits for a beat in flight, so none can write after a release. */
  stop(): Promise<void>;
}

/**
 * Rewrites `heartbeatAt` while the lock is held, so other containers (whose pid they cannot see)
 * can tell a running holder from a dead one. Never throws: a missed beat only matters if the
 * holder stays silent for LOCK_HEARTBEAT_TIMEOUT_MS.
 */
function startHeartbeat(lockPath: string, mine: OwnLock, options: AcquireLockOptions): Heartbeat {
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

function handleFor(lockPath: string, mine: OwnLock, options: AcquireLockOptions): RunLock {
  const heartbeat = startHeartbeat(lockPath, mine, options);
  let released = false;
  return {
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

/**
 * Removes the temp files that a killed run left next to the lock and its takeover guard
 * (`digest.lock.<pid>.<uuid>.tmp`). Housekeeping only: a failure is logged, never raised, so it
 * can not keep a run from starting.
 */
async function sweepOrphanedTempFiles(options: AcquireLockOptions): Promise<void> {
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

/**
 * Serialises takeovers: only one contender at a time may remove a stale lock, otherwise two of
 * them can both inspect it as stale and the second removes the first one's fresh lock.
 * Returns false when an abandoned guard was cleared and the caller should try again.
 */
async function acquireTakeoverGuard(
  guardPath: string,
  mine: OwnLock,
  options: AcquireLockOptions,
): Promise<boolean> {
  if (await create(guardPath, mine)) return true;

  const guard = await inspect(guardPath, options.clock.now(), mine, 'guard');
  if (guard.kind === 'held') throw inProgress(guard.lock);
  if (guard.kind === 'stale') {
    options.logger.warn('Removing abandoned lock takeover guard', { reason: guard.reason });
    await rm(guardPath, { force: true });
  }
  return false;
}

/**
 * Replaces a stale lock with ours. Returns false when someone else got there first.
 * The guard is re-checked before each destructive step: another run may have broken it as
 * abandoned (a crash, or us frozen for over 30 s) and now holds a guard of its own.
 */
async function takeOverStaleLock(mine: OwnLock, options: AcquireLockOptions): Promise<boolean> {
  const { lockPath, clock, logger } = options;
  const guardPath = `${lockPath}${GUARD_SUFFIX}`;
  if (!(await acquireTakeoverGuard(guardPath, mine, options))) return false;

  try {
    // Look again under the guard: another run may have replaced the stale lock meanwhile.
    const state = await inspect(lockPath, clock.now(), mine, 'lock');
    if (state.kind === 'held') throw inProgress(state.lock);
    if (state.kind === 'stale') {
      if (!(await isOurs(guardPath, mine))) return false;
      logger.warn('Taking over stale run lock', { reason: state.reason, previous: state.lock });
      await rm(lockPath, { force: true });
    }
    return await create(lockPath, mine);
  } finally {
    if (await isOurs(guardPath, mine)) await rm(guardPath, { force: true });
  }
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
 *
 * Temp files that a killed run left next to the lock are removed once they are
 * ORPHANED_TEMP_MAX_AGE_MS old, whether or not the lock can be taken.
 *
 * Known limits (docs/runbook.md has the operator's view):
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
  const startedAt = clock.now().toISOString();
  const mine: OwnLock = {
    pid: process.pid,
    runId,
    startedAt,
    // An empty name would make our own lock look unreadable (the schema wants a name).
    hostname: options.hostname ?? (osHostname() || 'unknown'),
    token: PROCESS_TOKEN,
    pidNamespace: options.pidNamespace ?? (await readPidNamespace()),
    heartbeatAt: startedAt,
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await create(lockPath, mine)) return handleFor(lockPath, mine, options);

    const state = await inspect(lockPath, clock.now(), mine, 'lock');
    if (state.kind === 'held') throw inProgress(state.lock);
    if (state.kind === 'stale' && (await takeOverStaleLock(mine, options))) {
      return handleFor(lockPath, mine, options);
    }
  }
  throw new DigestError('Could not take the run lock: another run is starting');
}
