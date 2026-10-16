import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { RunLock } from '../../ports/RunStore.js';
import type { Clock } from '../../shared/clock.js';
import { DigestError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';
import { createFileExclusive, isErrnoException, readTextIfExists } from './atomicFile.js';

/** A lock older than this is presumed abandoned even if its pid is alive (pid reuse). */
export const LOCK_MAX_AGE_MS = 6 * 3_600_000;
/** A takeover is over in milliseconds; a guard this old was left behind by a crashed run. */
export const TAKEOVER_GUARD_MAX_AGE_MS = 30_000;

const MAX_ATTEMPTS = 3;
const GUARD_SUFFIX = '.takeover';

const LockFileSchema = z.object({
  pid: z.number().int().positive(),
  runId: z.string(),
  startedAt: z.iso.datetime({ offset: true }),
});
type LockFile = z.infer<typeof LockFileSchema>;

type LockState =
  | { kind: 'free' }
  | { kind: 'held'; lock: LockFile }
  | { kind: 'stale'; reason: string; lock?: LockFile };

export interface AcquireLockOptions {
  lockPath: string;
  runId: string;
  clock: Clock;
  logger: Logger;
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

async function inspect(path: string, now: Date, maxAgeMs: number): Promise<LockState> {
  const text = await readTextIfExists(path);
  if (text === undefined) return { kind: 'free' };

  const lock = parseLockFile(text);
  if (lock === undefined) return { kind: 'stale', reason: 'lock file is unreadable' };
  if (!isPidAlive(lock.pid)) return { kind: 'stale', reason: 'process is not running', lock };
  if (now.getTime() - Date.parse(lock.startedAt) >= maxAgeMs) {
    return { kind: 'stale', reason: 'lock is too old', lock };
  }
  return { kind: 'held', lock };
}

function inProgress(lock: LockFile): DigestError {
  return new DigestError(
    `Another run is in progress (pid ${String(lock.pid)}, week ${lock.runId})`,
  );
}

function sameLock(a: LockFile, b: LockFile): boolean {
  return a.pid === b.pid && a.runId === b.runId && a.startedAt === b.startedAt;
}

function create(path: string, lock: LockFile): Promise<boolean> {
  return createFileExclusive(path, JSON.stringify(lock));
}

/** True when the file at `path` is the one we created (same pid, run and start time). */
async function isOurs(path: string, mine: LockFile): Promise<boolean> {
  const text = await readTextIfExists(path);
  const current = text === undefined ? undefined : parseLockFile(text);
  return current !== undefined && sameLock(current, mine);
}

function handleFor(lockPath: string, mine: LockFile): RunLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      // Leave a lock alone when another run took it over after we were presumed dead.
      if (await isOurs(lockPath, mine)) await rm(lockPath, { force: true });
      // Only after success, so a failed release can be retried.
      released = true;
    },
  };
}

/**
 * Serialises takeovers: only one contender at a time may remove a stale lock, otherwise two of
 * them can both inspect it as stale and the second removes the first one's fresh lock.
 * Returns false when an abandoned guard was cleared and the caller should try again.
 */
async function acquireTakeoverGuard(
  guardPath: string,
  mine: LockFile,
  options: AcquireLockOptions,
): Promise<boolean> {
  if (await create(guardPath, mine)) return true;

  const guard = await inspect(guardPath, options.clock.now(), TAKEOVER_GUARD_MAX_AGE_MS);
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
async function takeOverStaleLock(mine: LockFile, options: AcquireLockOptions): Promise<boolean> {
  const { lockPath, clock, logger } = options;
  const guardPath = `${lockPath}${GUARD_SUFFIX}`;
  if (!(await acquireTakeoverGuard(guardPath, mine, options))) return false;

  try {
    // Look again under the guard: another run may have replaced the stale lock meanwhile.
    const state = await inspect(lockPath, clock.now(), LOCK_MAX_AGE_MS);
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
 * Takes the single-run lock. Throws DigestError (exit 1) when a live, recent run holds it;
 * a dead, expired or unreadable lock is taken over with a warning.
 *
 * Known limit: plain files give no OS-level lock, so the check-then-remove steps of a takeover
 * (and of release) leave a window of a few syscalls. It only matters when a run crashed or was
 * frozen for longer than the guard/lock expiry while another run starts at the same moment.
 */
export async function acquireRunLock(options: AcquireLockOptions): Promise<RunLock> {
  const { lockPath, runId, clock } = options;
  await mkdir(dirname(lockPath), { recursive: true });
  const mine: LockFile = { pid: process.pid, runId, startedAt: clock.now().toISOString() };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (await create(lockPath, mine)) return handleFor(lockPath, mine);

    const state = await inspect(lockPath, clock.now(), LOCK_MAX_AGE_MS);
    if (state.kind === 'held') throw inProgress(state.lock);
    if (state.kind === 'stale' && (await takeOverStaleLock(mine, options))) {
      return handleFor(lockPath, mine);
    }
  }
  throw new DigestError('Could not take the run lock: another run is starting');
}
