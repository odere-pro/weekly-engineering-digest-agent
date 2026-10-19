import { Cron } from 'croner';
import type { RunStatus } from '../domain/schemas';
import type { Clock } from '../shared/clock';
import { DigestError, errorMessage } from '../shared/errors';
import { isoWeekId } from '../shared/isoWeek';
import type { Logger } from '../shared/telemetry';
import { catchUp } from './catchUp/catchUp';
import { runWithRetries } from './retry/runWithRetries';
import type { GiveUp, RetryContext, RunWeek, Trigger } from './retry/types';
import { budgetOf, createWaiter } from './retry/wait';
import { DEFAULT_RUN_TIMEOUT_MS } from './runLimit/runLimit';
import { HOUR_MS, MINUTE_MS } from './timing';

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

/** How a run that ends `failed` tries again, on the same week: at most `times` more attempts. */
export interface FailedRetry {
  /** Wait between attempts. Zero turns retrying off. */
  everyMs: number;
  /** Zero turns retrying off. */
  times: number;
}

export interface SchedulerOptions {
  cron: string;
  timeZone: string;
  /**
   * Runs one week. The signal fires when the run exceeds `runTimeoutMs`; pass it on as
   * `RunOptions.signal` so the run ends `failed` and releases its lock. `attempt` is always given;
   * it is optional in the type so a caller that does not care can leave it out of its signature.
   * Passing its `notifyFailure` on is what makes a retried week send one failure note; a `run`
   * that ignores it sends its note anyway and the scheduler may send a second one on give-up.
   */
  run: RunWeek;
  /** How the week's saved run ended, if it has one. Used for missed-week catch-up on start. */
  runStatus: (weekId: string) => Promise<RunStatus | undefined>;
  clock: Clock;
  logger: Logger;
  /** Default: every 5 minutes for 2 hours. */
  lockRetry?: LockRetry;
  /**
   * Default: none. A retry re-runs the week and keeps `whenIdle()` waiting, so the caller asks for
   * it; `digest serve` passes `DEFAULT_FAILED_RETRY`.
   */
  failedRetry?: FailedRetry;
  /** Longest a run may take before its signal fires. Default: 3 hours. Zero or less: no limit. */
  runTimeoutMs?: number;
  /**
   * Sends the failure note of a week that failed and will not be tried again. An attempt that is
   * going to be retried holds its note back (`RunAttempt.notifyFailure`); if the retry then does
   * not happen (`stop()` cancels it, the lock stays held, or it throws instead of running) this is
   * called once, with the last failed result, so the week does not end without a note. It is called
   * at most once per scheduled run and `whenIdle()` waits for it. A rejection is logged. Without
   * it the scheduler holds no note back. After a `stop()` the next start runs a failed week again,
   * and that run notifies for itself: the note of a new failure, not a second one for this.
   */
  onGiveUp?: GiveUp;
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

type Execute = (weekId: string, trigger: Trigger) => Promise<void>;

interface Executor {
  execute: Execute;
  /** True while a digest is being built; false while a retry waits. */
  isRunning(): boolean;
  /** Cancels a pending retry; a later failure does not start another. */
  stop(): void;
  whenIdle(): Promise<void>;
}

const DEFAULT_LOCK_RETRY: LockRetry = { everyMs: 5 * MINUTE_MS, forMs: 2 * HOUR_MS };
/** The policy of the service (F13): two more tries, 30 minutes apart, on the same week. */
export const DEFAULT_FAILED_RETRY: FailedRetry = { everyMs: 30 * MINUTE_MS, times: 2 };
const NO_FAILED_RETRY: FailedRetry = { everyMs: 0, times: 0 };

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
function createExecutor(options: SchedulerOptions): Executor {
  const { logger, lockRetry = DEFAULT_LOCK_RETRY, failedRetry = NO_FAILED_RETRY } = options;
  const timer = createWaiter();
  let stopped = false;
  const retries: RetryContext = {
    settings: {
      run: options.run,
      logger,
      runTimeoutMs: options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      onGiveUp: options.onGiveUp,
    },
    budgets: {
      'lock-held': budgetOf(lockRetry.everyMs, lockRetry.forMs / lockRetry.everyMs),
      failed: budgetOf(failedRetry.everyMs, failedRetry.times),
    },
    timer,
    isStopped: () => stopped,
  };
  let current: Promise<void> | undefined;

  const execute: Execute = (weekId, trigger) => {
    if (current !== undefined) {
      logger.warn('Skipped a scheduled run: the previous run is still going', { weekId, trigger });
      return Promise.resolve();
    }
    const finished = runWithRetries(retries, weekId, trigger).finally(() => {
      current = undefined;
    });
    current = finished;
    return finished;
  };
  return {
    execute,
    isRunning: () => current !== undefined && !timer.isWaiting(),
    stop: () => {
      stopped = true;
      timer.cancel();
    },
    whenIdle: () => current ?? Promise.resolve(),
  };
}
