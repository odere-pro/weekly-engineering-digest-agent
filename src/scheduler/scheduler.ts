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
   * `RunOptions.signal` so the run ends `failed` and releases its lock.
   */
  run: (weekId: string, signal: AbortSignal) => Promise<RunResult>;
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
  /** Cancels a pending retry; a later failure does not start another. */
  stop(): void;
  whenIdle(): Promise<void>;
}

/** Why another attempt may help: another process holds the lock, or the run ended `failed`. */
type RetryKind = 'lock-held' | 'failed';

/** How one attempt ended: nothing more to do, or a reason to try again. */
type Attempt = { kind: 'finished' } | { kind: RetryKind; error: string };

/** The wait between attempts of one kind, and how many attempts it may add. */
interface Budget {
  everyMs: number;
  max: number;
}

/** What one attempt needs from the options. */
interface AttemptSettings {
  run: SchedulerOptions['run'];
  logger: Logger;
  runTimeoutMs: number;
}

/** The run lock is held by another process; the store adapter reports it with this message. */
const LOCK_HELD_PREFIX = 'Another run is in progress';
/** Ends the error of a resume that only a person can clear (`runResume.ts`), so a retry is futile. */
const NEEDS_FORCE = '--force';
const MINUTE_MS = 60_000;

/** Catch-up leaves a week that ended this way alone; a failed or dry-run week runs again. */
const SETTLED: ReadonlySet<RunStatus> = new Set<RunStatus>(['sent', 'quiet', 'blocked']);
const HOUR_MS = 3_600_000;
const DEFAULT_LOCK_RETRY: LockRetry = { everyMs: 5 * MINUTE_MS, forMs: 2 * HOUR_MS };
/** The policy of the service (F13): two more tries, 30 minutes apart, on the same week. */
export const DEFAULT_FAILED_RETRY: FailedRetry = { everyMs: 30 * MINUTE_MS, times: 2 };
const NO_FAILED_RETRY: FailedRetry = { everyMs: 0, times: 0 };
const DEFAULT_RUN_TIMEOUT_MS = 3 * HOUR_MS;
/** The longest delay setTimeout holds; a larger one fires at once, so such a limit means none. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The furthest a time zone's local Monday 00:00 can lie before Monday 00:00 UTC (UTC+14). */
const MAX_UTC_OFFSET_MS = 14 * HOUR_MS;

const RETRY_LOGS: Readonly<Record<RetryKind, { retrying: string; gaveUp: string }>> = {
  'lock-held': {
    retrying: 'Another run holds the lock; will retry',
    gaveUp: 'Scheduled run gave up: another run kept the lock',
  },
  failed: {
    retrying: 'The run ended failed; will retry',
    gaveUp: 'Scheduled run gave up: the run kept failing',
  },
};

const FINISHED: Attempt = { kind: 'finished' };

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

/** What the retry loop reads: how an attempt runs, how long each reason may retry, the timer. */
interface RetryContext {
  settings: AttemptSettings;
  budgets: Readonly<Record<RetryKind, Budget>>;
  timer: Waiter;
  isStopped: () => boolean;
}

/** Tries again after the wait of the reason's budget, until the budget is spent or stop() came. */
async function runWithRetries(
  { settings, budgets, timer, isStopped }: RetryContext,
  weekId: string,
  trigger: Trigger,
): Promise<void> {
  const { logger } = settings;
  const used: Record<RetryKind, number> = { 'lock-held': 0, failed: 0 };
  for (;;) {
    const attempt = await attemptRun(settings, weekId, trigger);
    if (attempt.kind === 'finished') return;
    const { kind, error } = attempt;
    const { everyMs, max } = budgets[kind];
    // No retry asked for: the "finished" log and the failure note have already said it failed.
    if (kind === 'failed' && max === 0) return;
    if (!isStopped() && used[kind] >= max) {
      logger.error(RETRY_LOGS[kind].gaveUp, { weekId, trigger, retries: used[kind], error });
      return;
    }
    if (!isStopped()) {
      const next = { retry: used[kind] + 1, ofMax: max, inMs: everyMs, error };
      logger.warn(RETRY_LOGS[kind].retrying, { weekId, trigger, ...next });
    }
    if (isStopped() || !(await timer.wait(everyMs))) {
      logger.info('Retry cancelled: the scheduler stopped', { weekId, trigger });
      return;
    }
    used[kind] += 1;
  }
}

/**
 * Retrying needs a wait a timer can hold and a count above zero; zero, negative, NaN and a wait
 * beyond `MAX_TIMER_MS` (which would fire at once) turn it off.
 */
function budgetOf(everyMs: number, count: number): Budget {
  const on = everyMs > 0 && everyMs <= MAX_TIMER_MS && count > 0;
  return { everyMs, max: on ? Math.floor(count) : 0 };
}

/** One timer at a time, shared by every wait between attempts, that stop() can cut short. */
interface Waiter {
  /** Resolves true when the time has passed, false when cancel() cut the wait short. */
  wait: (ms: number) => Promise<boolean>;
  cancel: () => void;
  isWaiting: () => boolean;
}

function createWaiter(): Waiter {
  let cancelWait: (() => void) | undefined;
  return {
    wait: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          cancelWait = undefined;
          resolve(true);
        }, ms);
        cancelWait = () => {
          clearTimeout(timer);
          cancelWait = undefined;
          resolve(false);
        };
      }),
    cancel: () => {
      cancelWait?.();
    },
    isWaiting: () => cancelWait !== undefined,
  };
}

/** One call of `run` under its time limit. Never throws; says whether another attempt may help. */
async function attemptRun(
  { run, logger, runTimeoutMs }: AttemptSettings,
  weekId: string,
  trigger: Trigger,
): Promise<Attempt> {
  const limit = startRunLimit(runTimeoutMs, () => {
    logger.error('Scheduled run hit its time limit; asking it to stop', {
      weekId,
      trigger,
      limitMs: runTimeoutMs,
    });
  });
  try {
    const result = await run(weekId, limit.signal);
    logger.info('Scheduled run finished', {
      weekId,
      trigger,
      status: result.record.status,
      exitCode: result.exitCode,
    });
    return afterRun(logger, result, { weekId, trigger, timedOut: limit.timedOut() });
  } catch (error) {
    if (isLockHeld(error)) return { kind: 'lock-held', error: error.message };
    logger.error('Scheduled run failed', { weekId, trigger, error: errorMessage(error) });
    return FINISHED;
  } finally {
    limit.clear();
  }
}

/**
 * A run that ends `failed` is worth another try, except two kinds: one that hit the time limit
 * (another try would take as long again, and a slow or hung model is not a blip), and a resume
 * that only `digest run --force` can clear.
 */
function afterRun(
  logger: Logger,
  { record }: RunResult,
  { weekId, trigger, timedOut }: { weekId: string; trigger: Trigger; timedOut: boolean },
): Attempt {
  if (record.status !== 'failed') return FINISHED;
  if (timedOut) {
    logger.warn('Not retrying a run that hit its time limit', { weekId, trigger });
    return FINISHED;
  }
  const message = record.error?.message;
  if (message?.includes(NEEDS_FORCE)) {
    logger.warn('Not retrying: finishing this week needs "digest run --force"', {
      weekId,
      trigger,
      error: message,
    });
    return FINISHED;
  }
  return { kind: 'failed', error: message ?? 'The run ended failed' };
}

interface RunLimit {
  /** Fires, with a reason the scheduler wrote, when the limit passes. */
  signal: AbortSignal;
  timedOut: () => boolean;
  /** Stops the timer; call when the run is over. */
  clear: () => void;
}

/** A signal that fires after `ms`. A limit that is not a positive number a timer can hold is none. */
function startRunLimit(ms: number, onTimeout: () => void): RunLimit {
  const controller = new AbortController();
  const timer =
    ms > 0 && ms <= MAX_TIMER_MS
      ? setTimeout(() => {
          onTimeout();
          // The reason lands in run.json and the failure note: the limit, nothing from the run.
          controller.abort(new Error(`run timed out after ${describeDuration(ms)}`));
        }, ms)
      : undefined;
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

function describeDuration(ms: number): string {
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
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
