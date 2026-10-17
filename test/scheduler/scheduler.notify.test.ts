// W5-12: the scheduler tells each attempt whether its failure note may go out. One root cause
// then sends one note, from the last attempt; a run nobody will retry sends its note at once.
// (scheduler.test.ts is at the file size cap, so these tests have a file of their own.)
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../src/core/runDigest.js';
import { ExitCode, type RunStatus } from '../../src/core/schemas.js';
import {
  DEFAULT_FAILED_RETRY,
  startScheduler,
  type CronFactory,
  type FailedRetry,
  type SchedulerHandle,
  type SchedulerOptions,
} from '../../src/scheduler/scheduler.js';
import { DigestError } from '../../src/shared/errors.js';
import type { Logger } from '../../src/shared/telemetry.js';
import { makeRunRecord } from '../builders.js';
import { fixedClock } from '../fakes/index.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Monday 2026-10-12 07:45 in Berlin (CEST, UTC+2). */
const BERLIN_SLOT = '2026-10-12T05:45:00Z';

interface MockLogger extends Logger {
  debug: Mock<Logger['debug']>;
  info: Mock<Logger['info']>;
  warn: Mock<Logger['warn']>;
  error: Mock<Logger['error']>;
}

function mockLogger(): MockLogger {
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function resultWith(status: RunStatus, message?: string): RunResult {
  const failure = message === undefined ? undefined : { message, step: 'deliver' as const };
  return {
    record: makeRunRecord({ status, ...(failure && { error: failure }) }),
    exitCode: status === 'failed' ? ExitCode.Failed : ExitCode.Sent,
  };
}

const sent = resultWith('sent');
const failed = (message = 'Ollama is not reachable'): RunResult => resultWith('failed', message);
const lockHeld = (): DigestError => new DigestError('Another run is in progress (pid 4242)');

function notifyOf(call: Parameters<SchedulerOptions['run']>): boolean {
  const attempt = call[2];
  if (attempt === undefined) throw new Error('The scheduler called run without an attempt');
  return attempt.notifyFailure;
}

type GiveUp = NonNullable<SchedulerOptions['onGiveUp']>;

interface Harness {
  options: SchedulerOptions;
  run: Mock<SchedulerOptions['run']>;
  onGiveUp: Mock<GiveUp>;
  logger: MockLogger;
  tick: () => Promise<void> | undefined;
  /** The `notifyFailure` of each call of `run`, in order. */
  notifies: () => boolean[];
}

/** Fake timers for setTimeout only, and a cron that never fires, so each test drives the ticks. */
function harness(overrides: Partial<SchedulerOptions> = {}): Harness {
  vi.useFakeTimers({ now: new Date(BERLIN_SLOT), toFake: ['setTimeout', 'clearTimeout'] });
  const handlers: (() => Promise<void>)[] = [];
  const cronFactory: CronFactory = (_pattern, _options, handler) => {
    handlers.push(handler);
    return { nextRun: () => new Date('2027-01-01T00:00:00Z'), stop: () => undefined };
  };
  const run = vi.fn<SchedulerOptions['run']>(() => Promise.resolve(sent));
  const onGiveUp = vi.fn<GiveUp>(() => Promise.resolve());
  const logger = mockLogger();
  const options: SchedulerOptions = {
    cron: '45 7 * * 1',
    timeZone: 'Europe/Berlin',
    run,
    runStatus: () => Promise.resolve('sent'),
    clock: fixedClock(BERLIN_SLOT),
    logger,
    cronFactory,
    failedRetry: DEFAULT_FAILED_RETRY,
    onGiveUp,
    ...overrides,
  };
  return {
    options,
    run,
    onGiveUp,
    logger,
    tick: () => handlers[0]?.(),
    notifies: () => run.mock.calls.map((call) => notifyOf(call)),
  };
}

const handles: SchedulerHandle[] = [];

async function start(options: SchedulerOptions): Promise<SchedulerHandle> {
  const handle = await startScheduler(options);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  vi.useRealTimers();
});

/** Runs the tick to its end, moving the clock past every wait. */
async function settle(h: Harness): Promise<void> {
  const tick = h.tick();
  await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
  await tick;
}

describe('scheduler: notifyFailure per attempt', () => {
  it('holds the note of every attempt but the last when a failed run is retried twice', async () => {
    const h = harness();
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.notifies()).toEqual([false, false, true]);
  });

  it('asks only the last attempt for its note, however early the run recovers', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValue(sent);
    await start(h.options);

    await settle(h);

    expect(h.notifies()).toEqual([false, false]);
  });

  it('gives the last attempt its note even when the attempt before it recovered nothing', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValueOnce(failed()).mockResolvedValue(sent);
    await start(h.options);

    await settle(h);

    expect(h.notifies()).toEqual([false, false, true]);
  });

  it('follows the retry count of failedRetry', async () => {
    const failedRetry: FailedRetry = { everyMs: 1_000, times: 4 };
    const h = harness({ failedRetry });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.notifies()).toEqual([false, false, false, false, true]);
  });

  it('notifies on the one attempt there is when the caller asked for no retry', async () => {
    const h = harness({ failedRetry: undefined });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.notifies()).toEqual([true]);
  });

  it.each<[string, FailedRetry]>([
    ['a zero delay', { everyMs: 0, times: 2 }],
    ['a count of zero', { everyMs: 1_000, times: 0 }],
    ['a count that is not a number', { everyMs: 1_000, times: Number.NaN }],
    ['a delay no timer can hold', { everyMs: 10 ** 12, times: 2 }],
  ])('notifies on the only attempt when %s turns retrying off', async (_name, failedRetry) => {
    const h = harness({ failedRetry });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.notifies()).toEqual([true]);
  });

  it('keeps the lock-held retries out of the count: they run nothing and send no note', async () => {
    const h = harness();
    h.run
      .mockRejectedValueOnce(lockHeld())
      .mockRejectedValueOnce(lockHeld())
      .mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    // Two lock misses, then the run itself: three tries of a failing run, the last one notifies.
    expect(h.notifies().slice(2)).toEqual([false, false, true]);
  });

  it('counts a failed attempt that follows a lock-held one against its own budget', async () => {
    const h = harness();
    h.run
      .mockResolvedValueOnce(failed())
      .mockRejectedValueOnce(lockHeld())
      .mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    // failed (retry left), lock held, failed (one retry left), failed (none left).
    expect(h.notifies()).toEqual([false, false, false, true]);
  });

  it('starts every tick with a fresh count', async () => {
    const h = harness();
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);
    await settle(h);

    expect(h.notifies()).toEqual([false, false, true, false, false, true]);
  });

  it('gives a catch-up run the same treatment', async () => {
    // The slot of this week has passed and the week failed, so the start runs the week itself.
    const cronFactory: CronFactory = () => ({
      nextRun: () => new Date(BERLIN_SLOT),
      stop: () => undefined,
    });
    const h = harness({
      cronFactory,
      clock: fixedClock('2026-10-14T10:00:00Z'),
      runStatus: () => Promise.resolve('failed'),
    });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.notifies()).toEqual([false, false, true]);
  });
});

describe('scheduler: a run nobody will retry', () => {
  it('still passes the attempt its flag: the run itself sends the note of a timeout at once', async () => {
    // The scheduler cannot know a run will hit its limit; runDigest sends the note of a run
    // whose signal fired whatever the flag says. The scheduler only must not retry it.
    const h = harness({ runTimeoutMs: HOUR_MS });
    h.run.mockImplementation(
      (_week, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve(failed('Run aborted before the collect step: run timed out after 1 h'));
          });
        }),
    );
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.notifies()).toEqual([false]);
    expect(h.onGiveUp).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      'Not retrying a run that hit its time limit',
      expect.objectContaining({ weekId: '2026-W42' }),
    );
  });

  it('does not retry a resume that only --force can clear', async () => {
    const h = harness();
    h.run.mockResolvedValue(
      failed('digest.md is gone; run with --force to send a new digest to every channel'),
    );
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('--force'),
      expect.objectContaining({ weekId: '2026-W42' }),
    );
  });

  it('notifies on the last attempt of a run that keeps failing and says it gave up', async () => {
    const h = harness();
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('gave up'),
      expect.objectContaining({ retries: 2, error: 'Ollama is not reachable' }),
    );
  });
});

describe('scheduler: logs about the held note', () => {
  it('says in the retry log that the note of that attempt was held back', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValue(sent);
    await start(h.options);

    await settle(h);

    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({ retry: 1, ofMax: 2, noteHeldBack: true }),
    );
  });

  it('does not say it for a lock-held retry, which sent nothing', async () => {
    const h = harness();
    h.run.mockRejectedValueOnce(lockHeld()).mockResolvedValue(sent);
    await start(h.options);

    await settle(h);

    const fields = h.logger.warn.mock.calls.map(([, logged]) => logged);
    expect(fields.some((logged) => logged?.noteHeldBack !== undefined)).toBe(false);
  });

  it('says a retry held a note while it waits for the lock', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockRejectedValueOnce(lockHeld()).mockResolvedValue(sent);
    await start(h.options);

    await settle(h);

    expect(h.logger.warn).toHaveBeenCalledWith(
      'Another run holds the lock; will retry',
      expect.objectContaining({ noteHeldBack: true }),
    );
  });

  it('forgets the held note once a later run settles the week', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValueOnce(sent);
    await start(h.options);

    await settle(h);

    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('lets a later failure decide for itself: the note of a last attempt is not held', async () => {
    const h = harness({ failedRetry: { everyMs: MINUTE_MS, times: 1 } });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.notifies()).toEqual([false, true]);
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      'Scheduled run gave up: the run kept failing',
      expect.not.objectContaining({ noteHeldBack: true }),
    );
  });
});
