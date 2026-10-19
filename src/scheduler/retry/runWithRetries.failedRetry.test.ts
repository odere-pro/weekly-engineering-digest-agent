// W5-09 (F13): the scheduler's failed-run retry, seen through startScheduler. The loop is also
// tested on its own in runWithRetries.test.ts; the lock-held retry in
// runWithRetries.lockRetry.test.ts.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/runDigest';
import { ExitCode, type RunStatus } from '../../domain/schemas';
import {
  DEFAULT_FAILED_RETRY,
  startScheduler,
  type CronFactory,
  type FailedRetry,
  type SchedulerHandle,
  type SchedulerOptions,
} from '../scheduler';
import { DigestError } from '../../shared/errors';
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
/** What the store adapter throws while another run holds the lock. */
const lockHeld = (): DigestError => new DigestError('Another run is in progress (pid 4242)');

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

describe('scheduler failed-run retry', () => {
  it('runs a week that ended failed again after 30 minutes', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValue(sent);
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS - 1);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({
        weekId: '2026-W42',
        trigger: 'schedule',
        retry: 1,
        ofMax: 2,
        inMs: 30 * MINUTE_MS,
        error: 'Slack webhook answered HTTP 503',
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(2);
    // This scheduler has no onGiveUp to send a held note, so every attempt sends its own
    // (runWithRetries.giveUp.test.ts covers the held note).
    expect(h.run).toHaveBeenLastCalledWith('2026-W42', expect.any(AbortSignal), {
      notifyFailure: true,
    });
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('retries at most twice, then gives up with an error log', async () => {
    const h = harness();
    h.run.mockResolvedValue(failed());
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('gave up'),
      expect.objectContaining({
        weekId: '2026-W42',
        trigger: 'schedule',
        retries: 2,
        error: 'Slack webhook answered HTTP 503',
      }),
    );
  });

  it('retries the same week on every attempt', async () => {
    const h = harness();
    h.run.mockResolvedValue(failed());
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await tick;

    expect(h.run.mock.calls.map(([weekId]) => weekId)).toEqual([
      '2026-W42',
      '2026-W42',
      '2026-W42',
    ]);
  });

  it('takes the delay and the count from failedRetry', async () => {
    const failedRetry: FailedRetry = { everyMs: 1_000, times: 3 };
    const h = harness({ failedRetry });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10_000);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(4);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('gave up'),
      expect.objectContaining({ retries: 3 }),
    );
  });

  it.each<[string, FailedRetry]>([
    ['a zero delay', { everyMs: 0, times: 2 }],
    ['a count of zero', { everyMs: 1_000, times: 0 }],
    ['a count that is not a number', { everyMs: 1_000, times: Number.NaN }],
    ['a delay that is not a number', { everyMs: Number.NaN, times: 2 }],
    ['a delay no timer can hold', { everyMs: 10 ** 12, times: 2 }],
  ])('does not retry with %s', async (_name, failedRetry) => {
    const h = harness({ failedRetry });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await h.tick();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('retries nothing unless the caller asks for it', async () => {
    const h = harness({ failedRetry: undefined });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await h.tick();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('keeps the policy of the service at two tries, 30 minutes apart', () => {
    expect(DEFAULT_FAILED_RETRY).toEqual({ everyMs: 30 * MINUTE_MS, times: 2 });
  });

  it('does not retry a failure that a resume cannot clear without --force', async () => {
    const h = harness();
    h.run.mockResolvedValue(
      failed(
        'digest.md no longer matches the digest markdown got; run with --force to send a new digest to every channel',
      ),
    );
    await start(h.options);

    await h.tick();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('--force'),
      expect.objectContaining({ weekId: '2026-W42' }),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('retries a failure that has no recorded error', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(resultWith('failed')).mockResolvedValue(sent);
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it.each<RunStatus>(['sent', 'quiet', 'blocked', 'dry-run', 'skipped'])(
    'does not retry a run that ended %s',
    async (status) => {
      const h = harness();
      h.run.mockResolvedValue(resultWith(status));
      await start(h.options);

      await h.tick();
      await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

      expect(h.run).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a run that threw, which is not a failed record', async () => {
    const h = harness();
    h.run.mockRejectedValue(new Error('disk gone'));
    await start(h.options);

    await h.tick();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('retries a catch-up run that ended failed', async () => {
    const h = harness({ now: '2026-10-14T10:00:00Z', status: 'failed', catchUp: true });
    h.run.mockResolvedValueOnce(failed()).mockResolvedValue(sent);
    await start(h.options);
    await vi.waitFor(() => {
      expect(h.run).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

    await vi.waitFor(() => {
      expect(h.run).toHaveBeenCalledTimes(2);
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({ trigger: 'catch-up' }),
    );
  });

  it('keeps the lock-held budget apart: a retry that meets the lock waits five minutes', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockRejectedValueOnce(lockHeld()).mockResolvedValue(sent);
    await start(h.options);

    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(h.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('cancels a pending retry on stop()', async () => {
    const h = harness();
    h.run.mockResolvedValue(failed());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cancelled'),
      expect.objectContaining({ weekId: '2026-W42' }),
    );
    expect(h.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('finishes first'));
    await expect(handle.whenIdle()).resolves.toBeUndefined();
  });

  it('does not wait for a retry when stop() came while the run was going', async () => {
    const h = harness();
    let finish: (value: RunResult) => void = () => undefined;
    h.run.mockReturnValueOnce(new Promise<RunResult>((resolve) => (finish = resolve)));
    const handle = await start(h.options);
    const tick = h.tick();

    handle.stop();
    finish(failed());
    await tick;
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cancelled'),
      expect.objectContaining({ weekId: '2026-W42' }),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('is not idle while a retry is pending', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValue(sent);
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    let idle = false;
    const waiting = handle.whenIdle().then(() => {
      idle = true;
    });
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(idle).toBe(false);

    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    await waiting;
    await tick;

    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('skips a tick that comes while a retry is pending', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValue(sent);
    await start(h.options);
    const first = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    await h.tick();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped'),
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    await first;
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});
