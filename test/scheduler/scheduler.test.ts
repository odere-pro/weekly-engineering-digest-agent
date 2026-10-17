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

describe('startScheduler tick', () => {
  it('creates the job with the cron, time zone and overrun protection', async () => {
    const { factory, calls } = fakeCron();
    const { options } = harness('2026-10-14T10:00:00Z', { cronFactory: factory, status: 'sent' });

    await start(options);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.pattern).toBe(DEFAULT_CRON);
    expect(calls[0]?.options).toMatchObject({ timezone: BERLIN, protect: true });
    expect(calls[0]?.options.catch).toBeTypeOf('function');
  });

  it('runs the current ISO week on every tick', async () => {
    const { factory, calls } = fakeCron();
    const { options, run } = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent' });
    await start(options);

    await calls[0]?.handler();

    expect(run).toHaveBeenCalledExactlyOnceWith('2026-W42', ...ATTEMPT);
  });

  it('reads the week in the configured time zone', async () => {
    const { factory, calls } = fakeCron();
    // Sunday 23:30 UTC is already Monday 01:30 in Berlin: week 43 there, week 42 in UTC.
    const { options, run } = harness('2026-10-18T23:30:00Z', {
      cronFactory: factory,
      status: 'sent',
    });
    await start(options);

    await calls[0]?.handler();

    expect(run).toHaveBeenCalledWith('2026-W43', ...ATTEMPT);
  });

  it('logs a failed run and does not throw', async () => {
    const { factory, calls } = fakeCron();
    const h = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent' });
    h.run.mockRejectedValue(new Error('ollama is down'));
    await start(h.options);

    await expect(calls[0]?.handler()).resolves.toBeUndefined();

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ weekId: '2026-W42', error: 'ollama is down' }),
    );
  });

  it('logs the outcome of a finished run', async () => {
    const { factory, calls } = fakeCron();
    const h = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent' });
    await start(h.options);

    await calls[0]?.handler();

    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('finished'),
      expect.objectContaining({ weekId: '2026-W42', exitCode: ExitCode.Sent }),
    );
  });

  it('keeps ticking after a failure', async () => {
    const { factory, calls } = fakeCron();
    const h = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent' });
    h.run.mockRejectedValueOnce(new Error('boom'));
    await start(h.options);

    await calls[0]?.handler();
    await calls[0]?.handler();

    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while a run is still in flight', async () => {
    const { factory, calls } = fakeCron();
    const h = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent' });
    let finish: (value: RunResult) => void = () => undefined;
    h.run.mockReturnValueOnce(new Promise<RunResult>((resolve) => (finish = resolve)));
    await start(h.options);

    const first = calls[0]?.handler();
    await calls[0]?.handler();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalled();

    finish(runResult);
    await first;
    await calls[0]?.handler();
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});

describe('startScheduler safety net', () => {
  it('logs anything the job reports through its catch option', async () => {
    const { factory, calls } = fakeCron();
    const h = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent' });
    await start(h.options);

    calls[0]?.options.catch(new Error('tick exploded'));

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('tick failed'),
      expect.objectContaining({ error: 'tick exploded' }),
    );
  });

  it('stops the job and rejects when the catch-up itself throws', async () => {
    const { factory, calls } = fakeCron(new Date('2026-10-12T05:45:00Z'));
    const h = harness('2026-10-14T10:00:00Z', { cronFactory: factory });
    h.logger.info.mockImplementation(() => {
      throw new Error('logger broke');
    });

    await expect(startScheduler(h.options)).rejects.toThrow('logger broke');

    expect(calls[0]?.stop).toHaveBeenCalledOnce();
  });
});

describe('startScheduler handle', () => {
  it('reports the next run of the job', async () => {
    const next = new Date('2026-10-19T05:45:00Z');
    const { factory } = fakeCron(next);
    const { options } = harness('2026-10-14T10:00:00Z', { cronFactory: factory, status: 'sent' });

    const handle = await start(options);

    expect(handle.nextRun()).toEqual(next);
  });

  it('asks the job for the next run after the injected clock', async () => {
    const { factory, calls } = fakeCron();
    const now = '2026-10-14T10:00:00Z';
    const { options } = harness(now, { cronFactory: factory, status: 'sent' });
    const handle = await start(options);

    handle.nextRun();

    expect(calls[0]?.nextRun).toHaveBeenLastCalledWith(new Date(now));
  });

  it('reports the next slot after the injected clock with the real cron', async () => {
    // Months from the real date: a nextRun that read the real time would land elsewhere.
    const { options } = harness('2026-03-04T10:00:00Z', { status: 'sent' });

    const handle = await start(options);

    // Monday 2026-03-09 07:45 in Berlin is 06:45 UTC (CET, UTC+1).
    expect(handle.nextRun()).toEqual(new Date('2026-03-09T06:45:00Z'));
  });

  it('stops the job', async () => {
    const { factory, calls } = fakeCron();
    const { options } = harness('2026-10-14T10:00:00Z', { cronFactory: factory, status: 'sent' });
    const handle = await start(options);

    handle.stop();

    expect(calls[0]?.stop).toHaveBeenCalledOnce();
  });

  it('is idle when no run is in flight', async () => {
    const { factory } = fakeCron();
    const { options } = harness('2026-10-14T10:00:00Z', { cronFactory: factory, status: 'sent' });
    const handle = await start(options);

    await expect(handle.whenIdle()).resolves.toBeUndefined();
  });

  it('is not idle until the run in flight has finished', async () => {
    const { factory, calls } = fakeCron();
    const h = harness(BERLIN_SLOT, { cronFactory: factory, status: 'sent' });
    let finish: (value: RunResult) => void = () => undefined;
    h.run.mockReturnValueOnce(new Promise<RunResult>((resolve) => (finish = resolve)));
    const handle = await start(h.options);
    const tick = calls[0]?.handler();

    handle.stop();
    let idle = false;
    const waiting = handle.whenIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(idle).toBe(false);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('finishes first'));

    finish(runResult);
    await waiting;
    await tick;
    expect(idle).toBe(true);
  });

  it('rejects an invalid cron with a readable error', async () => {
    const { options } = harness('2026-10-14T10:00:00Z', { cron: 'not a cron' });

    const error = await startScheduler(options).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toContain('not a cron');
  });

  it('rejects an unknown time zone with a readable error', async () => {
    const { options } = harness('2026-10-14T10:00:00Z', { timeZone: 'Mars/Olympus' });

    const error = await startScheduler(options).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toContain('Mars/Olympus');
  });
});

describe('startScheduler with the real cron', () => {
  it('stops ticking after stop()', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-12T05:00:00Z'), toFake: ['setTimeout', 'Date'] });
    const h = harness('2026-10-12T05:00:00Z', { status: 'sent' });
    const handle = await start(h.options);

    handle.stop();
    await vi.advanceTimersByTimeAsync(46 * 60_000);

    expect(h.run).not.toHaveBeenCalled();
  });

  it('fires on the schedule in the configured time zone', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-12T05:00:00Z'), toFake: ['setTimeout', 'Date'] });
    const h = harness('2026-10-12T05:00:00Z', { status: 'sent' });
    const handle = await start(h.options);
    expect(handle.nextRun()).toEqual(new Date(BERLIN_SLOT));

    await vi.advanceTimersByTimeAsync(46 * 60_000);

    expect(h.run).toHaveBeenCalledExactlyOnceWith('2026-W42', ...ATTEMPT);
  });
});
