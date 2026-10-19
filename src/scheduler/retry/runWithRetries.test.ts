import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/runDigest';
import { RecordNotSavedError } from '../../digest/runEnding';
import { ExitCode, type RunStatus } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';
import { HOUR_MS, MINUTE_MS } from '../timing';
import { runWithRetries } from './runWithRetries';
import type { GiveUp, RetryContext, RunWeek } from './types';
import { budgetOf, createWaiter } from './wait';

const where = { weekId: '2026-W42', trigger: 'schedule' } as const;
const LOCK_HELD = 'Another run is in progress (pid 4242)';

interface MockLogger extends Logger {
  warn: Mock<Logger['warn']>;
  info: Mock<Logger['info']>;
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
const failed = (message = 'HTTP 503'): RunResult => resultWith('failed', message);

interface Setup {
  context: RetryContext;
  run: Mock<RunWeek>;
  logger: MockLogger;
  onGiveUp: Mock<GiveUp>;
  stop: () => void;
}

/** Failed runs retry twice, 30 minutes apart; a held lock every 5 minutes for 2 hours. */
function setup(options: { giveUpHook?: boolean; failedTimes?: number } = {}): Setup {
  const { giveUpHook = true, failedTimes = 2 } = options;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const logger = mockLogger();
  const run = vi.fn<RunWeek>(() => Promise.resolve(sent));
  const onGiveUp = vi.fn<GiveUp>(() => Promise.resolve());
  const timer = createWaiter();
  let stopped = false;
  const context: RetryContext = {
    settings: {
      run,
      logger,
      runTimeoutMs: 3 * HOUR_MS,
      ...(giveUpHook && { onGiveUp }),
    },
    budgets: {
      'lock-held': budgetOf(5 * MINUTE_MS, (2 * HOUR_MS) / (5 * MINUTE_MS)),
      failed: budgetOf(30 * MINUTE_MS, failedTimes),
    },
    timer,
    isStopped: () => stopped,
  };
  return {
    context,
    run,
    logger,
    onGiveUp,
    stop: () => {
      stopped = true;
      timer.cancel();
    },
  };
}

function notifyFlags(run: Mock<RunWeek>): (boolean | undefined)[] {
  return run.mock.calls.map(([, , attempt]) => attempt?.notifyFailure);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runWithRetries: one attempt is enough', () => {
  it('runs a week that sent once, without a retry or a note', async () => {
    const { context, run, onGiveUp } = setup();

    await runWithRetries(context, where.weekId, where.trigger);

    expect(run).toHaveBeenCalledOnce();
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a run that threw an error, and hands over nothing it does not owe', async () => {
    const { context, run, onGiveUp } = setup();
    run.mockRejectedValue(new Error('disk gone'));

    await runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(run).toHaveBeenCalledOnce();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe('runWithRetries: a failed run is tried again', () => {
  it('holds the note back while a retry is left, and sends it from the last attempt', async () => {
    const { context, run } = setup();
    run.mockResolvedValue(failed());

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await finished;

    expect(notifyFlags(run)).toEqual([false, false, true]);
  });

  it('leaves the note to the last attempt, so onGiveUp has nothing to send when every retry failed', async () => {
    const { context, run, onGiveUp, logger } = setup();
    run.mockResolvedValue(failed('still down'));

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await finished;

    expect(run).toHaveBeenCalledTimes(3);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Scheduled run gave up: the run kept failing',
      expect.objectContaining({ retries: 2 }),
    );
  });

  it('owes nothing when a retry sends, even after a held note', async () => {
    const { context, run, onGiveUp } = setup();
    run.mockResolvedValueOnce(failed()).mockResolvedValue(sent);

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    await finished;

    expect(run).toHaveBeenCalledTimes(2);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('never holds a note back without an onGiveUp to send it', async () => {
    const { context, run } = setup({ giveUpHook: false });
    run.mockResolvedValue(failed());

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    await finished;

    expect(notifyFlags(run)).toEqual([true, true, true]);
  });

  it('does not retry, and does not hold a note, when failed retries are off', async () => {
    const { context, run, onGiveUp } = setup({ failedTimes: 0 });
    run.mockResolvedValue(failed());

    await runWithRetries(context, where.weekId, where.trigger);

    expect(notifyFlags(run)).toEqual([true]);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('stops retrying and sends the held note when the scheduler stops during the wait', async () => {
    const { context, run, onGiveUp, stop } = setup();
    const first = failed('first');
    run.mockResolvedValue(first);

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    stop();
    await finished;

    expect(run).toHaveBeenCalledOnce();
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', first);
  });

  it('holds no note for an attempt that starts after stop(): nobody could send it later', async () => {
    const { context, run, onGiveUp, stop } = setup();
    run.mockResolvedValue(failed());
    stop();

    await runWithRetries(context, where.weekId, where.trigger);

    expect(notifyFlags(run)).toEqual([true]);
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe('runWithRetries: a held lock', () => {
  it('waits five minutes and runs the same week again', async () => {
    const { context, run } = setup();
    run.mockRejectedValueOnce(new DigestError(LOCK_HELD)).mockResolvedValue(sent);

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS - 1);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await finished;

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('gives up after two hours of tries, and sends the note an earlier attempt held back', async () => {
    const { context, run, onGiveUp } = setup();
    const earlier = failed('earlier failure');
    run.mockResolvedValueOnce(earlier).mockRejectedValue(new DigestError(LOCK_HELD));

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(40 * HOUR_MS);
    await finished;

    // One failed run, then one try plus 24 retries against the lock.
    expect(run).toHaveBeenCalledTimes(1 + 1 + 24);
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', earlier);
  });
});

describe('runWithRetries: an attempt nobody retries', () => {
  it('hands over the note of a run that hit its time limit and held it', async () => {
    const { context, run, onGiveUp } = setup();
    const result = failed('the model hung');
    run.mockImplementation(
      (_weekId, signal, _attempt) =>
        new Promise<RunResult>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve(result);
          });
        }),
    );

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    await finished;

    expect(run).toHaveBeenCalledOnce();
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', result);
  });

  it('hands over the earlier held note when a retry throws', async () => {
    const { context, run, onGiveUp } = setup();
    const earlier = failed('first');
    run.mockResolvedValueOnce(earlier).mockRejectedValue(new Error('disk gone'));

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    await finished;

    expect(run).toHaveBeenCalledTimes(2);
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', earlier);
  });

  it('does not send the held note again when the retry already noted why it threw', async () => {
    const { context, run, onGiveUp } = setup();
    run
      .mockResolvedValueOnce(failed('first'))
      .mockRejectedValue(new RecordNotSavedError('no space'));

    const finished = runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    await finished;

    expect(run).toHaveBeenCalledTimes(2);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('does not retry a failure that only --force can clear, and holds no note for it', async () => {
    const { context, run, onGiveUp } = setup();
    run.mockResolvedValue(failed('the digest changed; run with --force to send it'));

    await runWithRetries(context, where.weekId, where.trigger);
    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

    expect(run).toHaveBeenCalledOnce();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});
