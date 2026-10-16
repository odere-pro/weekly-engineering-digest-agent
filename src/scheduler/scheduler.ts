import { Cron } from 'croner';
import type { RunResult } from '../core/runDigest.js';
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

export interface SchedulerOptions {
  cron: string;
  timeZone: string;
  run: (weekId: string) => Promise<RunResult>;
  /** Used for missed-week catch-up on start. */
  hasSentDigest: (weekId: string) => Promise<boolean>;
  clock: Clock;
  logger: Logger;
  /** Default: croner. */
  cronFactory?: CronFactory;
}

export interface SchedulerHandle {
  /** Next scheduled run, if any. */
  nextRun(): Date | null;
  /** Stops future ticks. A run already in flight keeps going; see `whenIdle`. */
  stop(): void;
  /** Resolves when no run is in flight (at once when none is). */
  whenIdle(): Promise<void>;
}

type Trigger = 'schedule' | 'catch-up';
type Execute = (weekId: string, trigger: Trigger) => Promise<void>;

interface Executor {
  execute: Execute;
  isRunning(): boolean;
  whenIdle(): Promise<void>;
}

const HOUR_MS = 3_600_000;
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
    nextRun: () => job.nextRun(),
    stop: () => {
      job.stop();
      if (executor.isRunning()) logger.info('Scheduler stopped; the running digest finishes first');
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
function createExecutor({ run, logger }: SchedulerOptions): Executor {
  let current: Promise<void> | undefined;

  async function runOnce(weekId: string, trigger: Trigger): Promise<void> {
    try {
      const result = await run(weekId);
      logger.info('Scheduled run finished', {
        weekId,
        trigger,
        status: result.record.status,
        exitCode: result.exitCode,
      });
    } catch (error) {
      logger.error('Scheduled run failed', { weekId, trigger, error: errorMessage(error) });
    }
  }

  const execute: Execute = (weekId, trigger) => {
    if (current !== undefined) {
      logger.warn('Skipped a scheduled run: the previous run is still going', { weekId, trigger });
      return Promise.resolve();
    }
    const finished = runOnce(weekId, trigger).finally(() => {
      current = undefined;
    });
    current = finished;
    return finished;
  };
  return {
    execute,
    isRunning: () => current !== undefined,
    whenIdle: () => current ?? Promise.resolve(),
  };
}

/** Runs the current week now if its slot has passed and no digest was sent for it. */
async function catchUp(job: CronJob, options: SchedulerOptions, execute: Execute): Promise<void> {
  const { timeZone, clock, logger, hasSentDigest } = options;
  const now = clock.now();
  const weekId = isoWeekId(now, timeZone);
  const slot = firstSlotOfWeek(job, weekId, timeZone);
  if (slot === null || slot.getTime() > now.getTime()) return;

  try {
    if (await hasSentDigest(weekId)) return;
  } catch (error) {
    logger.error('Missed-week catch-up skipped: could not read the run store', {
      weekId,
      error: errorMessage(error),
    });
    return;
  }
  logger.info('Catching up on a missed run', { weekId, slot: slot.toISOString() });
  // Not awaited: a run takes minutes, and the caller needs the handle to be able to stop.
  void execute(weekId, 'catch-up');
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
