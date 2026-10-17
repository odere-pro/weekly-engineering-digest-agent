import { Cron } from 'croner';
import type { RunResult } from '../core/runDigest.js';
import type { RunStatus } from '../core/schemas.js';
import type { Clock } from '../shared/clock.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import { compareWeekIds, isoWeekId, weekStartUtc } from '../shared/isoWeek.js';
import type { Logger } from '../shared/telemetry.js';

/** The part of a cron job the scheduler uses; croner's `Cron` satisfies it. */
export interface CronJob {
  nextRun(from?: Date): Date | null;
  stop(): void;
}

export interface CronJobOptions {
  timezone: string;
  /** Skip a tick while the previous handler is still running. */
  protect: boolean;
  /** Receives anything the handler throws, so a tick can never become an unhandled rejection. */
  catch: (error: unknown) => void;
}

/** Starts a job that calls `handler` on every tick. Tests replace it. */
export type CronFactory = (
  pattern: string,
  options: CronJobOptions,
  handler: () => Promise<void>,
) => CronJob;

/** How a tick that meets a held run lock tries again, e.g. a manual `digest run` still going. */
export interface LockRetry {
  /** Wait between tries. Zero turns retrying off. */
  everyMs: number;
  /** Stop retrying this long after the first try. Zero turns retrying off. */
  forMs: number;
}

export interface SchedulerOptions {
  cron: string;
  timeZone: string;
  run: (weekId: string) => Promise<RunResult>;
  /** How the week's saved run ended, if it has one. Used for missed-week catch-up on start. */
  runStatus: (weekId: string) => Promise<RunStatus | undefined>;
  clock: Clock;
  logger: Logger;
  /** Default: every 5 minutes for 2 hours. */
  lockRetry?: LockRetry;
  /** Default: croner. */
  cronFactory?: CronFactory;
}

export interface SchedulerHandle {
  /** Next scheduled run, if any. */
  nextRun(): Date | null;
  /** Stops future ticks and cancels a pending retry. A run already in flight keeps going. */
  stop(): void;
  /** Resolves when no run is in flight or waiting to retry (at once when none is). */
  whenIdle(): Promise<void>;
}

type Trigger = 'schedule' | 'catch-up';
type Execute = (weekId: string, trigger: Trigger) => Promise<void>;

interface Executor {
  execute: Execute;
  /** True while a digest is being built; false while a retry waits. */
  isRunning(): boolean;
  /** Cancels a pending retry; a later lock-held failure does not start another. */
  stop(): void;
  whenIdle(): Promise<void>;
}

/** The run lock is held by another process; the store adapter reports it with this message. */
const LOCK_HELD_PREFIX = 'Another run is in progress';
const MINUTE_MS = 60_000;

/** Catch-up leaves a week that ended this way alone; a failed or dry-run week runs again. */
const SETTLED: ReadonlySet<RunStatus> = new Set<RunStatus>(['sent', 'quiet', 'blocked']);
const HOUR_MS = 3_600_000;
const DEFAULT_LOCK_RETRY: LockRetry = { everyMs: 5 * MINUTE_MS, forMs: 2 * HOUR_MS };
/** The furthest a time zone's local Monday 00:00 can lie before Monday 00:00 UTC (UTC+14). */
const MAX_UTC_OFFSET_MS = 14 * HOUR_MS;

const croner: CronFactory = (pattern, options, handler) => new Cron(pattern, options, handler);

/** In-process weekly scheduler with missed-week catch-up (W1-16). */
export async function startScheduler(options: SchedulerOptions): Promise<SchedulerHandle> {
  const { cron, timeZone, clock, logger, cronFactory = croner } = options;
  const executor = createExecutor(options);
  const job = createJob(options, cronFactory, () =>
    executor.execute(isoWeekId(clock.now(), timeZone), 'schedule'),
  );
  try {
    await catchUp(job, options, executor.execute);
  } catch (error) {
    job.stop();
    throw error;
  }
  logger.debug('Scheduler is waiting for the next tick', { cron, timeZone });
  return {
    nextRun: () => job.nextRun(clock.now()),
    stop: () => {
      job.stop();
      const running = executor.isRunning();
      executor.stop();
      if (running) logger.info('Scheduler stopped; the running digest finishes first');
    },
    whenIdle: () => executor.whenIdle(),
  };
}

function createJob(
  { cron, timeZone, logger }: SchedulerOptions,
  factory: CronFactory,
  handler: () => Promise<void>,
): CronJob {
  const jobOptions: CronJobOptions = {
    timezone: timeZone,
    protect: true,
    catch: (error) => {
      logger.error('Scheduled tick failed', { error: errorMessage(error) });
    },
  };
  try {
    return factory(cron, jobOptions, handler);
  } catch (cause) {
    throw new DigestError(
      `Invalid schedule (cron "${cron}", time zone "${timeZone}"): ${errorMessage(cause)}`,
      { cause },
    );
  }
}

/** Runs one week at a time and never throws: a failed run is logged and the service stays up. */
function createExecutor({
  run,
  logger,
  lockRetry = DEFAULT_LOCK_RETRY,
}: SchedulerOptions): Executor {
  const canRetry = lockRetry.everyMs > 0 && lockRetry.forMs > 0;
  const maxRetries = canRetry ? Math.floor(lockRetry.forMs / lockRetry.everyMs) : 0;
  let current: Promise<void> | undefined;
  let cancelWait: (() => void) | undefined;
  let stopped = false;

  /** Resolves true when the time has passed, false when stop() cancelled the wait. */
  function wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cancelWait = undefined;
        resolve(true);
      }, ms);
      cancelWait = () => {
        clearTimeout(timer);
        cancelWait = undefined;
        resolve(false);
      };
    });
  }

  /** Returns the lock-held error when another run holds the lock; logs every other outcome. */
  async function runOnce(weekId: string, trigger: Trigger): Promise<DigestError | undefined> {
    try {
      const result = await run(weekId);
      logger.info('Scheduled run finished', {
        weekId,
        trigger,
        status: result.record.status,
        exitCode: result.exitCode,
      });
    } catch (error) {
      if (isLockHeld(error)) return error;
      logger.error('Scheduled run failed', { weekId, trigger, error: errorMessage(error) });
    }
    return undefined;
  }

  /** A tick that meets the lock tries again every `everyMs`, up to `maxRetries` times. */
  async function runWithRetries(weekId: string, trigger: Trigger): Promise<void> {
    for (let retries = 0; ; retries += 1) {
      const held = await runOnce(weekId, trigger);
      if (held === undefined) return;
      if (!stopped && retries >= maxRetries) {
        logger.error('Scheduled run gave up: another run kept the lock', {
          weekId,
          trigger,
          retries,
          error: held.message,
        });
        return;
      }
      if (!stopped) {
        logger.warn('Another run holds the lock; will retry', {
          weekId,
          trigger,
          retry: retries + 1,
          ofMax: maxRetries,
          inMs: lockRetry.everyMs,
        });
      }
      if (stopped || !(await wait(lockRetry.everyMs))) {
        logger.info('Retry cancelled: the scheduler stopped', { weekId, trigger });
        return;
      }
    }
  }

  const execute: Execute = (weekId, trigger) => {
    if (current !== undefined) {
      logger.warn('Skipped a scheduled run: the previous run is still going', { weekId, trigger });
      return Promise.resolve();
    }
    const finished = runWithRetries(weekId, trigger).finally(() => {
      current = undefined;
    });
    current = finished;
    return finished;
  };
  return {
    execute,
    isRunning: () => current !== undefined && cancelWait === undefined,
    stop: () => {
      stopped = true;
      cancelWait?.();
    },
    whenIdle: () => current ?? Promise.resolve(),
  };
}

function isLockHeld(error: unknown): error is DigestError {
  return error instanceof DigestError && error.message.startsWith(LOCK_HELD_PREFIX);
}

/** Runs the current week now if its slot has passed and the week has not settled. */
async function catchUp(job: CronJob, options: SchedulerOptions, execute: Execute): Promise<void> {
  const { timeZone, clock, logger } = options;
  const now = clock.now();
  const weekId = isoWeekId(now, timeZone);
  const slot = firstSlotOfWeek(job, weekId, timeZone);
  if (slot === null || slot.getTime() > now.getTime()) return;
  if (!(await isUnsettled(options, weekId))) return;

  logger.info('Catching up on a missed run', { weekId, slot: slot.toISOString() });
  // Not awaited: a run takes minutes, and the caller needs the handle to be able to stop.
  void execute(weekId, 'catch-up');
}

/** True when the week has no run, or one that failed or was dry; false when the store fails. */
async function isUnsettled(
  { runStatus, logger }: SchedulerOptions,
  weekId: string,
): Promise<boolean> {
  try {
    const status = await runStatus(weekId);
    if (status === undefined || !SETTLED.has(status)) return true;
    logger.debug('No catch-up: the week has settled', { weekId, status });
    return false;
  } catch (error) {
    logger.error('Missed-week catch-up skipped: could not read the run store', {
      weekId,
      error: errorMessage(error),
    });
    return false;
  }
}

/** The first fire inside the local ISO week `weekId`, or null when the cron never fires again. */
function firstSlotOfWeek(job: CronJob, weekId: string, timeZone: string): Date | null {
  // Local Monday 00:00 is never earlier than this. nextRun() is strictly after its argument,
  // so start 1 ms early to keep a fire at exactly local midnight (UTC+14) in reach.
  const from = new Date(weekStartUtc(weekId).getTime() - MAX_UTC_OFFSET_MS - 1);
  let slot = job.nextRun(from);
  while (slot !== null && compareWeekIds(isoWeekId(slot, timeZone), weekId) < 0) {
    slot = job.nextRun(slot);
  }
  return slot;
}
