// W5-12: a failed week never ends silently. When a failed attempt held its failure note for a
// retry and the retry does not happen, the scheduler hands the last failed result to `onGiveUp`,
// which sends the note, exactly once. (scheduler.test.ts is at the file size cap.)
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../digest/runDigest';
import { ExitCode, type RunStatus } from '../domain/schemas';
import {
  DEFAULT_FAILED_RETRY,
  startScheduler,
  type CronFactory,
  type SchedulerHandle,
  type SchedulerOptions,
} from './scheduler';
import { RecordNotSavedError } from '../digest/runEnding';
import { DigestError } from '../shared/errors';
import type { Logger } from '../shared/telemetry';
import { makeRunRecord } from '../../test/builders';
import { fixedClock } from '../../test/fakes';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Monday 2026-10-12 07:45 in Berlin (CEST, UTC+2). */
const BERLIN_SLOT = '2026-10-12T05:45:00Z';
const SENDING = 'Sending the failure note held back for a retry that will not run';

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
/** Each call makes a distinct result, so a test can tell which attempt's result came back. */
const failed = (message = 'Ollama is not reachable'): RunResult => resultWith('failed', message);
const lockHeld = (): DigestError => new DigestError('Another run is in progress (pid 4242)');

type GiveUp = NonNullable<SchedulerOptions['onGiveUp']>;

interface Harness {
  options: SchedulerOptions;
  run: Mock<SchedulerOptions['run']>;
  onGiveUp: Mock<GiveUp>;
  logger: MockLogger;
  tick: () => Promise<void> | undefined;
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
  return { options, run, onGiveUp, logger, tick: () => handlers[0]?.() };
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

describe('onGiveUp: the held note goes out once when the retry does not run', () => {
  it('when stop() cancels the pending retry', async () => {
    const h = harness();
    const first = failed();
    h.run.mockResolvedValue(first);
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(h.onGiveUp).not.toHaveBeenCalled();

    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
    expect(h.logger.warn).toHaveBeenCalledWith(
      SENDING,
      expect.objectContaining({ weekId: '2026-W42', reason: 'the scheduler stopped' }),
    );
  });

  it('when stop() came while the failing attempt was still running', async () => {
    const h = harness();
    const first = failed();
    let finish: (result: RunResult) => void = () => undefined;
    h.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    handle.stop();
    finish(first);
    await tick;

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
  });

  it('when stop() cancels a lock-held wait that follows a held failure', async () => {
    const h = harness();
    const first = failed();
    h.run.mockResolvedValueOnce(first).mockRejectedValue(lockHeld());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(31 * MINUTE_MS);
    expect(h.run).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await tick;

    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
  });

  it('when the lock stays held until the scheduler gives up', async () => {
    const h = harness({ lockRetry: { everyMs: MINUTE_MS, forMs: 3 * MINUTE_MS } });
    const first = failed();
    h.run.mockResolvedValueOnce(first).mockRejectedValue(lockHeld());
    await start(h.options);

    await settle(h);

    expect(h.logger.error).toHaveBeenCalledWith(
      'Scheduled run gave up: another run kept the lock',
      expect.objectContaining({ noteHeldBack: true }),
    );
    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
    expect(h.logger.warn).toHaveBeenCalledWith(
      SENDING,
      expect.objectContaining({ reason: 'another run kept the lock' }),
    );
  });

  it('when the retry throws outside the run', async () => {
    const h = harness();
    const first = failed();
    h.run.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.logger.error).toHaveBeenCalledWith(
      'Scheduled run failed',
      expect.objectContaining({ error: 'disk gone' }),
    );
    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
    expect(h.logger.warn).toHaveBeenCalledWith(
      SENDING,
      expect.objectContaining({ reason: 'the retry threw an error' }),
    );
  });

  it('with the result of the last failed attempt, not the first', async () => {
    const h = harness();
    const first = failed('first failure');
    const second = failed('second failure');
    h.run
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);

    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', second);
  });

  it('with the last failed result when stop() comes after two held failures', async () => {
    const h = harness();
    const first = failed('first failure');
    const second = failed('second failure');
    h.run.mockResolvedValueOnce(first).mockResolvedValue(second);
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(31 * MINUTE_MS);
    expect(h.run).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await tick;

    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', second);
  });

  it('when a held failure also hit the time limit, which the run did not know', async () => {
    // The limit fires after the run chose to hold its note, before the scheduler reads the result.
    const h = harness({ runTimeoutMs: HOUR_MS });
    const first = failed('Ollama is not reachable');
    h.run.mockImplementation(
      (_week, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve(first);
          });
        }),
    );
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(
      'Not retrying a run that hit its time limit',
      expect.any(Object),
    );
    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
  });

  it('for a catch-up run as for a scheduled one', async () => {
    const cronFactory: CronFactory = () => ({
      nextRun: () => new Date(BERLIN_SLOT),
      stop: () => undefined,
    });
    const h = harness({
      cronFactory,
      clock: fixedClock('2026-10-14T10:00:00Z'),
      runStatus: () => Promise.resolve('failed'),
    });
    const first = failed();
    h.run.mockResolvedValueOnce(first).mockRejectedValue(new Error('disk gone'));
    await start(h.options);

    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
  });

  it('and the service is not idle until the note has been handed over', async () => {
    const h = harness();
    let delivered = false;
    h.onGiveUp.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      delivered = true;
    });
    h.run.mockResolvedValue(failed());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    handle.stop();
    const idle = handle.whenIdle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await idle;
    await tick;

    expect(delivered).toBe(true);
  });
});

describe('onGiveUp: nothing is owed, so nothing is sent', () => {
  it('when the retry threw after sending its own note (it could not save its record)', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockRejectedValueOnce(
      new RecordNotSavedError('Could not save the run record (disk full); the run failed', {
        cause: new Error('disk full'),
      }),
    );
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.logger.error).toHaveBeenCalledWith(
      'Scheduled run failed',
      expect.objectContaining({ weekId: '2026-W42' }),
    );
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it('when the attempt before the last one recovers the week', async () => {
    const h = harness();
    h.run.mockResolvedValueOnce(failed()).mockResolvedValueOnce(sent);
    await start(h.options);

    await settle(h);

    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it('when every attempt fails: the last one sent its own note', async () => {
    const h = harness();
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it('when the retry ends with a failure whose note the run sent (a --force resume)', async () => {
    const h = harness();
    h.run
      .mockResolvedValueOnce(failed())
      .mockResolvedValueOnce(
        failed('digest.md is gone; run with --force to send a new digest to every channel'),
      );
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it('when a timeout ends the retry: the run sent the note of a run told to stop', async () => {
    const h = harness({ runTimeoutMs: HOUR_MS });
    h.run.mockResolvedValueOnce(failed());
    h.run.mockImplementationOnce(
      (_week, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve(failed('Run aborted before the collect step: run timed out after 1 h'));
          });
        }),
    );
    await start(h.options);

    await settle(h);

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it('when a stopped service ends a run that was told to stop: that run sent its own note', async () => {
    const h = harness();
    let finish: (result: RunResult) => void = () => undefined;
    h.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    handle.stop();
    finish(failed('Run aborted before the write step: the service was asked to stop again'));
    await tick;

    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it('when the first attempt itself throws: no note was held', async () => {
    const h = harness();
    h.run.mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);

    expect(h.onGiveUp).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith(
      'Scheduled run failed',
      expect.any(Object),
    );
  });

  it('when stop() cancels a lock wait and no failure was ever held', async () => {
    const h = harness({ lockRetry: { everyMs: MINUTE_MS, forMs: HOUR_MS } });
    h.run.mockRejectedValue(lockHeld());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

    handle.stop();
    await tick;

    expect(h.onGiveUp).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith(
      'Retry cancelled: the scheduler stopped',
      expect.any(Object),
    );
  });

  it('when no retry is configured: the only attempt sent its note', async () => {
    const h = harness({ failedRetry: undefined });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.onGiveUp).not.toHaveBeenCalled();
  });
});

describe('onGiveUp: once per week, whatever happens', () => {
  it('a second tick after a give-up starts clean and gives up for itself', async () => {
    const h = harness();
    const monday = failed('monday');
    const tuesday = failed('tuesday');
    h.run
      .mockResolvedValueOnce(monday)
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValueOnce(tuesday)
      .mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);
    await settle(h);

    expect(h.onGiveUp.mock.calls).toEqual([
      ['2026-W42', monday],
      ['2026-W42', tuesday],
    ]);
  });

  it('a lock miss, a failure, a lock miss and a throw hand over the failure once', async () => {
    const h = harness();
    const only = failed();
    h.run
      .mockRejectedValueOnce(lockHeld())
      .mockResolvedValueOnce(only)
      .mockRejectedValueOnce(lockHeld())
      .mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);

    expect(h.onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', only);
  });

  it('a note that cannot be handed over is logged, and the service goes on', async () => {
    const h = harness();
    h.onGiveUp.mockRejectedValue(new Error('every channel is down'));
    h.run.mockResolvedValueOnce(failed()).mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);

    expect(h.logger.error).toHaveBeenCalledWith(
      'Could not send the failure note held back',
      expect.objectContaining({ weekId: '2026-W42', error: 'every channel is down' }),
    );
    // The next tick still runs.
    h.run.mockResolvedValue(sent);
    await settle(h);
    expect(h.run).toHaveBeenCalledTimes(3);
  });

  it('a hook that throws before it returns a promise is logged the same way', async () => {
    const h = harness();
    h.onGiveUp.mockImplementation(() => {
      throw new Error('no deliveries configured');
    });
    h.run.mockResolvedValueOnce(failed()).mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);

    expect(h.logger.error).toHaveBeenCalledWith(
      'Could not send the failure note held back',
      expect.objectContaining({ error: 'no deliveries configured' }),
    );
  });

  it('a failing hand-over is not tried twice', async () => {
    const h = harness();
    h.onGiveUp.mockRejectedValue(new Error('every channel is down'));
    h.run.mockResolvedValueOnce(failed()).mockRejectedValueOnce(new Error('disk gone'));
    await start(h.options);

    await settle(h);

    expect(h.onGiveUp).toHaveBeenCalledTimes(1);
  });
});

describe('without onGiveUp the scheduler holds nothing', () => {
  it('asks every attempt to send its own note, so no failed week is silent', async () => {
    const h = harness({ onGiveUp: undefined });
    h.run.mockResolvedValue(failed());
    await start(h.options);

    await settle(h);

    expect(h.run.mock.calls.map(([, , attempt]) => attempt?.notifyFailure)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('keeps the plain cancel log when stop() ends a retry', async () => {
    const h = harness({ onGiveUp: undefined });
    h.run.mockResolvedValue(failed());
    const handle = await start(h.options);
    const tick = h.tick();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

    handle.stop();
    await tick;

    expect(h.logger.info).toHaveBeenCalledWith(
      'Retry cancelled: the scheduler stopped',
      expect.any(Object),
    );
    expect(h.logger.warn).not.toHaveBeenCalledWith(SENDING, expect.any(Object));
  });
});
