// W5-09 (F46): the scheduler's run time limit, seen through startScheduler. The limit itself
// (signal, reason text, timer) is also tested on its own in runLimit.test.ts.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/types';
import { ExitCode, type RunStatus } from '../../domain/schemas';
import {
  DEFAULT_FAILED_RETRY,
  startScheduler,
  type CronFactory,
  type SchedulerHandle,
  type SchedulerOptions,
} from '../scheduler';
import type { Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';
import { fixedClock } from '../../../test/fakes';

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
const failed = (message = 'Slack webhook answered HTTP 503'): RunResult =>
  resultWith('failed', message);

interface Harness {
  options: SchedulerOptions;
  run: Mock<SchedulerOptions['run']>;
  logger: MockLogger;
  tick: () => Promise<void> | undefined;
}

/**
 * Fake timers for setTimeout only, and a cron that never fires, so each test drives the ticks.
 * `catchUp`: this week's slot has passed, so the scheduler starts a catch-up run on its own.
 */
function harness(
  overrides: Partial<SchedulerOptions> & {
    now?: string;
    status?: RunStatus;
    catchUp?: boolean;
  } = {},
): Harness {
  const { now = BERLIN_SLOT, status = 'sent', catchUp = false, ...rest } = overrides;
  const nextRun = new Date(catchUp ? BERLIN_SLOT : '2027-01-01T00:00:00Z');
  vi.useFakeTimers({ now: new Date(now), toFake: ['setTimeout', 'clearTimeout'] });
  const handlers: (() => Promise<void>)[] = [];
  const cronFactory: CronFactory = (_pattern, _options, handler) => {
    handlers.push(handler);
    return { nextRun: () => nextRun, stop: () => undefined };
  };
  const run = vi.fn<SchedulerOptions['run']>(() => Promise.resolve(sent));
  const logger = mockLogger();
  const options: SchedulerOptions = {
    cron: '45 7 * * 1',
    timeZone: 'Europe/Berlin',
    run,
    runStatus: () => Promise.resolve(status),
    clock: fixedClock(now),
    logger,
    cronFactory,
    failedRetry: DEFAULT_FAILED_RETRY,
    ...rest,
  };
  return { options, run, logger, tick: () => handlers[0]?.() };
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

describe('scheduler run time limit', () => {
  /** A run that ends `failed` once its signal fires, as runDigest does between steps. */
  function runUntilAborted(): SchedulerOptions['run'] {
    return (_weekId, signal) =>
      new Promise<RunResult>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve(failed(`Run aborted before the write step: ${String(signal.reason)}`));
        });
      });
  }

  function signalOf(run: Mock<SchedulerOptions['run']>, call = 0): AbortSignal {
    const signal = run.mock.calls[call]?.[1];
    if (!signal) throw new Error('run was not given a signal');
    return signal;
  }

  it('gives each run a signal that has not fired', async () => {
    const h = harness();
    await start(h.options);

    await h.tick();

    expect(signalOf(h.run).aborted).toBe(false);
  });

  it('aborts a run that is still going after three hours', async () => {
    const h = harness();
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);
    const tick = h.tick();

    await vi.advanceTimersByTimeAsync(3 * HOUR_MS - 1);
    expect(signalOf(h.run).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await tick;

    expect(signalOf(h.run).aborted).toBe(true);
  });

  it('composes the reason itself: the limit, nothing from the run', async () => {
    const h = harness();
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);
    const tick = h.tick();

    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    await tick;

    const reason: unknown = signalOf(h.run).reason;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('run timed out after 3 h');
  });

  it('logs the time limit and does not retry a run that hit it', async () => {
    const h = harness();
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);
    const tick = h.tick();

    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    await tick;
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('time limit'),
      expect.objectContaining({ weekId: '2026-W42', trigger: 'schedule', limitMs: 3 * HOUR_MS }),
    );
  });

  it('takes the limit from runTimeoutMs, named in minutes when it is not whole hours', async () => {
    const h = harness({ runTimeoutMs: 90 * MINUTE_MS });
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);
    const tick = h.tick();

    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);
    await tick;

    expect((signalOf(h.run).reason as Error).message).toBe('run timed out after 90 min');
  });

  it.each<[number, string]>([
    [30_000, 'run timed out after 30 s'],
    [1_500, 'run timed out after 1500 ms'],
  ])('names a limit of %d ms in the unit that fits', async (runTimeoutMs, expected) => {
    const h = harness({ runTimeoutMs });
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);
    const tick = h.tick();

    await vi.advanceTimersByTimeAsync(runTimeoutMs);
    await tick;

    expect((signalOf(h.run).reason as Error).message).toBe(expected);
  });

  it('does not abort a run that finishes in time, and leaves no timer behind', async () => {
    const h = harness();
    await start(h.options);

    await h.tick();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4 * HOUR_MS);
    expect(signalOf(h.run).aborted).toBe(false);
  });

  it('leaves no timer behind when the run throws', async () => {
    const h = harness({ failedRetry: undefined });
    h.run.mockRejectedValue(new Error('boom'));
    await start(h.options);

    await h.tick();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no run timer behind when a thrown run waits for its retry', async () => {
    const h = harness();
    h.run.mockRejectedValue(new Error('boom'));
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(0);

    // Only the wait for the retry is pending, not the 3 h limit of the run that threw.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await tick;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<[string, number]>([
    ['zero', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('sets no limit when runTimeoutMs is %s', async (_name, runTimeoutMs) => {
    const h = harness({ runTimeoutMs });
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);

    void h.tick();
    await vi.advanceTimersByTimeAsync(100 * HOUR_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(signalOf(h.run).aborted).toBe(false);
  });

  it('does not fire at once for a limit beyond what a timer can hold', async () => {
    const h = harness({ runTimeoutMs: 10 ** 12 });
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);

    void h.tick();
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(signalOf(h.run).aborted).toBe(false);
  });

  it('limits a catch-up run too', async () => {
    const h = harness({ now: '2026-10-14T10:00:00Z', status: 'failed', catchUp: true });
    h.run.mockImplementation(runUntilAborted());
    await start(h.options);
    await vi.waitFor(() => {
      expect(h.run).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);

    await vi.waitFor(() => {
      expect(signalOf(h.run).aborted).toBe(true);
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('time limit'),
      expect.objectContaining({ trigger: 'catch-up' }),
    );
  });

  it('gives a retry its own signal, so an earlier limit does not carry over', async () => {
    const h = harness({ runTimeoutMs: HOUR_MS });
    h.run.mockResolvedValueOnce(failed()).mockImplementation(runUntilAborted());
    await start(h.options);
    const tick = h.tick();

    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(signalOf(h.run, 1)).not.toBe(signalOf(h.run, 0));
    expect(signalOf(h.run, 1).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await tick;

    expect(signalOf(h.run, 1).aborted).toBe(true);
  });

  it('does not abort a run when stop() is called: the run in flight finishes', async () => {
    const h = harness();
    h.run.mockImplementation(runUntilAborted());
    const handle = await start(h.options);
    void h.tick();

    handle.stop();

    expect(signalOf(h.run).aborted).toBe(false);
  });
});
