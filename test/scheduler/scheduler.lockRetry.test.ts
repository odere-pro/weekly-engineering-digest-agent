import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../src/core/runDigest.js';
import { ExitCode, type RunStatus } from '../../src/core/schemas.js';
import {
  startScheduler,
  type CronFactory,
  type CronJobOptions,
  type SchedulerHandle,
  type SchedulerOptions,
} from '../../src/scheduler/scheduler.js';
import { DigestError } from '../../src/shared/errors.js';
import type { Logger } from '../../src/shared/telemetry.js';
import { makeRunRecord } from '../builders.js';
import { fixedClock } from '../fakes/index.js';

const BERLIN = 'Europe/Berlin';
const DEFAULT_CRON = '45 7 * * 1';
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

const runResult: RunResult = { record: makeRunRecord(), exitCode: ExitCode.Sent };
/** What a run is called with after the week: its signal, and notifyFailure (no failed retry here). */
const ATTEMPT = [expect.any(AbortSignal), { notifyFailure: true }] as const;

interface Harness {
  options: SchedulerOptions;
  run: Mock<SchedulerOptions['run']>;
  runStatus: Mock<SchedulerOptions['runStatus']>;
  logger: MockLogger;
}

/** `status`: how the week's saved run ended; none by default. */
function harness(
  now: string,
  overrides: Partial<SchedulerOptions> & { status?: RunStatus } = {},
): Harness {
  const { status, ...rest } = overrides;
  const run = vi.fn<SchedulerOptions['run']>(() => Promise.resolve(runResult));
  const runStatus = vi.fn<SchedulerOptions['runStatus']>(() => Promise.resolve(status));
  const logger = mockLogger();
  const options: SchedulerOptions = {
    cron: DEFAULT_CRON,
    timeZone: BERLIN,
    run,
    runStatus,
    clock: fixedClock(now),
    logger,
    ...rest,
  };
  return { options, run, runStatus, logger };
}

interface FakeCronCall {
  pattern: string;
  options: CronJobOptions;
  handler: () => Promise<void>;
  stop: Mock<() => void>;
  nextRun: Mock<(from?: Date) => Date | null>;
}

/** A factory whose next run is far in the future, so it never triggers a catch-up. */
function fakeCron(nextRun: Date | null = new Date('2027-01-01T00:00:00Z')): {
  factory: CronFactory;
  calls: FakeCronCall[];
} {
  const calls: FakeCronCall[] = [];
  const factory: CronFactory = (pattern, options, handler) => {
    const stop = vi.fn<() => void>();
    const next = vi.fn<(from?: Date) => Date | null>(() => nextRun);
    calls.push({ pattern, options, handler, stop, nextRun: next });
    return { nextRun: next, stop };
  };
  return { factory, calls };
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

describe('startScheduler lock retry', () => {
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  /** What the store adapter throws while another run holds the lock. */
  const lockHeld = (): DigestError =>
    new DigestError('Another run is in progress (pid 4242, week 2026-W42)');

  function lockedHarness(overrides: Partial<SchedulerOptions> = {}) {
    vi.useFakeTimers({ now: new Date(BERLIN_SLOT), toFake: ['setTimeout', 'clearTimeout'] });
    const { factory, calls } = fakeCron();
    const h = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent', ...overrides });
    return { ...h, tick: () => calls[0]?.handler() };
  }

  it('retries after five minutes and runs once the lock is free', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValueOnce(lockHeld());
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS - 1);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('retry'),
      expect.objectContaining({ weekId: '2026-W42', trigger: 'schedule' }),
    );

    await vi.advanceTimersByTimeAsync(1);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.run).toHaveBeenLastCalledWith('2026-W42', ...ATTEMPT);
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('finished'),
      expect.objectContaining({ weekId: '2026-W42', trigger: 'schedule' }),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('keeps retrying every five minutes while the lock stays held', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValueOnce(lockHeld()).mockRejectedValueOnce(lockHeld());
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(3);
  });

  it('gives up after two hours with an error log', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValue(lockHeld());
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    await tick;

    // The first run and 24 retries, one every five minutes.
    expect(h.run).toHaveBeenCalledTimes(25);
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('gave up'),
      expect.objectContaining({
        weekId: '2026-W42',
        trigger: 'schedule',
        retries: 24,
        error: 'Another run is in progress (pid 4242, week 2026-W42)',
      }),
    );
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(h.run).toHaveBeenCalledTimes(25);
  });

  it('takes the delay and the cap from lockRetry', async () => {
    const h = lockedHarness({ lockRetry: { everyMs: 1_000, forMs: 2_500 } });
    h.run.mockRejectedValue(lockHeld());
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10_000);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('gave up'),
      expect.objectContaining({ retries: 2 }),
    );
  });

  it.each<[string, { everyMs: number; forMs: number }]>([
    ['a zero interval', { everyMs: 0, forMs: 1_000 }],
    ['a zero cap', { everyMs: 1_000, forMs: 0 }],
    ['a cap that is not a number', { everyMs: 1_000, forMs: Number.NaN }],
  ])('does not retry with %s', async (_name, lockRetry) => {
    const h = lockedHarness({ lockRetry });
    h.run.mockRejectedValue(lockHeld());
    await start(h.options);

    await h.tick();

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('gave up'),
      expect.objectContaining({ retries: 0 }),
    );
  });

  it('cancels a pending retry on stop()', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValue(lockHeld());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    handle.stop();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cancelled'),
      expect.objectContaining({ weekId: '2026-W42' }),
    );
    await expect(handle.whenIdle()).resolves.toBeUndefined();
  });

  it('does not retry when stop() came while the run was still trying for the lock', async () => {
    const h = lockedHarness();
    let refuse: (error: unknown) => void = () => undefined;
    h.run.mockReturnValueOnce(new Promise<RunResult>((_resolve, reject) => (refuse = reject)));
    const handle = await start(h.options);
    const tick = h.tick();

    handle.stop();
    refuse(lockHeld());
    await tick;
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cancelled'),
      expect.objectContaining({ weekId: '2026-W42' }),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('is not idle while a retry is pending', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValueOnce(lockHeld());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    let idle = false;
    const waiting = handle.whenIdle().then(() => {
      idle = true;
    });
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(idle).toBe(false);

    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    await waiting;
    await tick;

    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('does not claim a running digest when stop() meets a pending retry', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValue(lockHeld());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    handle.stop();
    await tick;

    expect(h.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('finishes first'));
  });

  it('skips a tick that comes while a retry is pending', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValueOnce(lockHeld());
    await start(h.options);
    const first = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    await h.tick();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped'),
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    await first;
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it.each<[string, unknown]>([
    ['a failure of the run', new DigestError('Ollama is not reachable. Start Ollama.')],
    ['an error that only mentions the lock', new Error('Another run is in progress')],
    ['a DigestError with another message', new DigestError('The lock was another run in progress')],
    ['something thrown that is not an error', 'Another run is in progress'],
  ])('does not retry %s', async (_name, error) => {
    const h = lockedHarness();
    h.run.mockRejectedValue(error);
    await start(h.options);

    await h.tick();
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ weekId: '2026-W42' }),
    );
  });

  it('stops retrying when a retry fails for another reason', async () => {
    const h = lockedHarness();
    h.run.mockRejectedValueOnce(lockHeld()).mockRejectedValueOnce(new Error('ollama is down'));
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    await tick;
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ weekId: '2026-W42', error: 'ollama is down' }),
    );
  });

  it('retries a catch-up run that met the lock', async () => {
    vi.useFakeTimers({
      now: new Date('2026-10-14T10:00:00Z'),
      toFake: ['setTimeout', 'clearTimeout'],
    });
    const h = harness('2026-10-14T10:00:00Z');
    h.run.mockRejectedValueOnce(lockHeld());
    await start(h.options);
    await vi.waitFor(() => {
      expect(h.run).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

    await vi.waitFor(() => {
      expect(h.run).toHaveBeenCalledTimes(2);
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('retry'),
      expect.objectContaining({ trigger: 'catch-up' }),
    );
  });
});
