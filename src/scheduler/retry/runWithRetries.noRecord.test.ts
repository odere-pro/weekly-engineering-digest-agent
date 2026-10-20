// COR-4: a week whose run throws instead of returning a result has no record to hang a note on.
// The scheduler retries it on the failed budget (a lock miss on the lock budget) and, when no
// attempt is left, sends exactly one note it composed itself through `onNoRecord`.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/types';
import { RecordNotSavedError } from '../../digest/ending/saveRecord';
import { ExitCode, type RunStatus } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';
import { HOUR_MS, MINUTE_MS } from '../timing';
import { runWithRetries } from './runWithRetries';
import type { GiveUp, RetryContext, RunWeek, SendNote } from './types';
import { budgetOf, createWaiter } from './wait';

const WEEK = '2026-W42';
const LOCK_HELD = 'Another run is in progress (pid 4242)';
const LOCK_MISS = 'Could not take the run lock: another run is starting';

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
const errno = (code: string, message: string): Error => Object.assign(new Error(message), { code });

interface Setup {
  context: RetryContext;
  run: Mock<RunWeek>;
  logger: MockLogger;
  onGiveUp: Mock<GiveUp>;
  onNoRecord: Mock<SendNote>;
  stop: () => void;
}

interface SetupOptions {
  failedTimes?: number;
  lockTimes?: number;
  runTimeoutMs?: number;
  noRecordHook?: boolean;
}

/** Defaults to the service's policy: two failed retries 30 minutes apart, locks 5 minutes for 2 h. */
function setup(options: SetupOptions = {}): Setup {
  const {
    failedTimes = 2,
    lockTimes = 24,
    runTimeoutMs = 3 * HOUR_MS,
    noRecordHook = true,
  } = options;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const logger = mockLogger();
  const run = vi.fn<RunWeek>(() => Promise.resolve(sent));
  const onGiveUp = vi.fn<GiveUp>(() => Promise.resolve());
  const onNoRecord = vi.fn<SendNote>(() => Promise.resolve());
  const timer = createWaiter();
  let stopped = false;
  const context: RetryContext = {
    settings: {
      run,
      logger,
      runTimeoutMs,
      onGiveUp,
      ...(noRecordHook && { onNoRecord }),
    },
    budgets: {
      'lock-held': budgetOf(5 * MINUTE_MS, lockTimes),
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
    onNoRecord,
    stop: () => {
      stopped = true;
      timer.cancel();
    },
  };
}

/** Runs the week to its end, moving the clock past every wait. */
async function settle(s: Setup, trigger: 'schedule' | 'catch-up' = 'schedule'): Promise<void> {
  const finished = runWithRetries(s.context, WEEK, trigger);
  await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
  await finished;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a run that throws: retried on the failed budget', () => {
  it('tries again after the failed wait and sends no note when the retry recovers', async () => {
    const s = setup();
    s.run.mockRejectedValueOnce(errno('EIO', 'EIO: i/o error')).mockResolvedValue(sent);

    const finished = runWithRetries(s.context, WEEK, 'schedule');
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS - 1);
    expect(s.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await finished;

    expect(s.run).toHaveBeenCalledTimes(2);
    expect(s.onNoRecord).not.toHaveBeenCalled();
    expect(s.onGiveUp).not.toHaveBeenCalled();
    expect(s.logger.warn).toHaveBeenCalledWith(
      'The run threw an error; will retry',
      expect.objectContaining({ weekId: WEEK, retry: 1, ofMax: 2, inMs: 30 * MINUTE_MS }),
    );
  });

  it("gives up after the failed budget and sends exactly one note, the scheduler's own", async () => {
    const s = setup();
    s.run.mockRejectedValue(errno('EIO', 'EIO: i/o error, read /secret/dist/2026-W42/run.json'));

    await settle(s);

    expect(s.run).toHaveBeenCalledTimes(3);
    expect(s.onNoRecord).toHaveBeenCalledExactlyOnceWith(
      WEEK,
      `The run for ${WEEK} stopped before it saved a record (EIO).`,
    );
    expect(s.onGiveUp).not.toHaveBeenCalled();
    expect(s.logger.error).toHaveBeenCalledWith(
      'Scheduled run gave up: the run kept throwing',
      expect.objectContaining({ weekId: WEEK, retries: 2 }),
    );
  });

  it('sends the note at once when no failed retry is configured', async () => {
    const s = setup({ failedTimes: 0 });
    s.run.mockRejectedValue(new Error('disk gone'));

    await settle(s);

    expect(s.run).toHaveBeenCalledOnce();
    expect(s.onNoRecord).toHaveBeenCalledExactlyOnceWith(
      WEEK,
      `The run for ${WEEK} stopped before it saved a record (Error).`,
    );
  });

  it('names a DigestError by its class, never by its text', async () => {
    const s = setup({ failedTimes: 0 });
    s.run.mockRejectedValue(new DigestError('cannot read /Users/me/.env: token=abc123'));

    await settle(s);

    const [, message] = s.onNoRecord.mock.calls[0] ?? [];
    expect(message).toBe(`The run for ${WEEK} stopped before it saved a record (DigestError).`);
    expect(message).not.toContain('abc123');
  });

  it('says so when what was thrown is not an error', async () => {
    const s = setup({ failedTimes: 0 });
    s.run.mockRejectedValue('token=abc123');

    await settle(s);

    expect(s.onNoRecord).toHaveBeenCalledExactlyOnceWith(
      WEEK,
      `The run for ${WEEK} stopped before it saved a record (unknown error).`,
    );
  });

  it('does not wait for a note hook that is not there', async () => {
    const s = setup({ noRecordHook: false });
    s.run.mockRejectedValue(new Error('disk gone'));

    await settle(s);

    expect(s.run).toHaveBeenCalledTimes(3);
    expect(s.onNoRecord).not.toHaveBeenCalled();
    expect(s.logger.error).toHaveBeenCalledWith(
      'Scheduled run gave up: the run kept throwing',
      expect.any(Object),
    );
  });

  it('does the same for a catch-up run', async () => {
    const s = setup({ failedTimes: 0 });
    s.run.mockRejectedValue(new Error('disk gone'));

    await settle(s, 'catch-up');

    expect(s.onNoRecord).toHaveBeenCalledOnce();
    expect(s.logger.error).toHaveBeenCalledWith(
      'Scheduled run gave up: the run kept throwing',
      expect.objectContaining({ trigger: 'catch-up' }),
    );
  });

  it('shares the failed budget with failed results: a failure then two throws is three attempts', async () => {
    const s = setup();
    s.run.mockResolvedValueOnce(failed()).mockRejectedValue(new Error('disk gone'));

    await settle(s);

    expect(s.run).toHaveBeenCalledTimes(3);
  });
});

describe('a run that throws: the one note stays one', () => {
  it('prefers the failure note an earlier attempt held back, and sends no second note', async () => {
    const s = setup();
    const earlier = failed('first failure');
    s.run.mockResolvedValueOnce(earlier).mockRejectedValue(new Error('disk gone'));

    await settle(s);

    expect(s.onGiveUp).toHaveBeenCalledExactlyOnceWith(WEEK, earlier);
    expect(s.onNoRecord).not.toHaveBeenCalled();
  });

  it('sends nothing when the run could not save its record: it sent that note itself', async () => {
    const s = setup();
    s.run.mockRejectedValue(new RecordNotSavedError('Could not save the run record (disk full)'));

    await settle(s);

    expect(s.run).toHaveBeenCalledOnce();
    expect(s.onNoRecord).not.toHaveBeenCalled();
    expect(s.onGiveUp).not.toHaveBeenCalled();
  });

  it('sends nothing for a throw when stop() cancels the retry wait: the next start runs the week', async () => {
    const s = setup();
    s.run.mockRejectedValue(new Error('disk gone'));

    const finished = runWithRetries(s.context, WEEK, 'schedule');
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    s.stop();
    await finished;

    expect(s.run).toHaveBeenCalledOnce();
    expect(s.onNoRecord).not.toHaveBeenCalled();
    expect(s.logger.info).toHaveBeenCalledWith(
      'Retry cancelled: the scheduler stopped',
      expect.any(Object),
    );
  });

  it('does not retry a throw that comes after the time limit fired, and notes it once', async () => {
    const s = setup({ runTimeoutMs: HOUR_MS });
    s.run.mockImplementation(
      (_week, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('lost the store'));
          });
        }),
    );

    await settle(s);

    expect(s.run).toHaveBeenCalledOnce();
    expect(s.onNoRecord).toHaveBeenCalledExactlyOnceWith(
      WEEK,
      `The run for ${WEEK} stopped before it saved a record (Error).`,
    );
  });

  it('logs a note that cannot be sent, and does not throw', async () => {
    const s = setup({ failedTimes: 0 });
    s.onNoRecord.mockRejectedValue(new Error('every channel is down'));
    s.run.mockRejectedValue(new Error('disk gone'));

    await expect(settle(s)).resolves.toBeUndefined();

    expect(s.onNoRecord).toHaveBeenCalledOnce();
    expect(s.logger.error).toHaveBeenCalledWith(
      'Could not send the scheduler failure note',
      expect.objectContaining({ weekId: WEEK, error: 'every channel is down' }),
    );
  });
});

describe('a lock miss while another run starts: held like a held lock', () => {
  it('retries it on the lock budget and sends nothing when the lock frees up', async () => {
    const s = setup();
    s.run.mockRejectedValueOnce(new DigestError(LOCK_MISS)).mockResolvedValue(sent);

    const finished = runWithRetries(s.context, WEEK, 'schedule');
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    await finished;

    expect(s.run).toHaveBeenCalledTimes(2);
    expect(s.onNoRecord).not.toHaveBeenCalled();
    expect(s.logger.warn).toHaveBeenCalledWith(
      'Another run holds the lock; will retry',
      expect.objectContaining({ retry: 1, inMs: 5 * MINUTE_MS, error: LOCK_MISS }),
    );
  });

  it('does not spend the failed budget', async () => {
    const s = setup();
    s.run
      .mockRejectedValueOnce(new DigestError(LOCK_MISS))
      .mockRejectedValueOnce(new DigestError(LOCK_MISS))
      .mockRejectedValue(new Error('disk gone'));

    await settle(s);

    // Two lock misses, then the throw uses the whole failed budget: 3 more attempts.
    expect(s.run).toHaveBeenCalledTimes(5);
  });

  it('does not take a plain Error with that text for a lock miss', async () => {
    const s = setup({ failedTimes: 0 });
    s.run.mockRejectedValue(new Error(LOCK_MISS));

    await settle(s);

    expect(s.run).toHaveBeenCalledOnce();
    expect(s.logger.warn).not.toHaveBeenCalledWith(
      'Another run holds the lock; will retry',
      expect.any(Object),
    );
  });
});

describe('the lock budget is spent', () => {
  const lockNote = `The run for ${WEEK} did not start: another run held the run lock for the whole retry budget.`;

  it.each([
    ['held', LOCK_HELD],
    ['being taken', LOCK_MISS],
  ])('sends one note when the lock stays %s', async (_name, message) => {
    const s = setup({ lockTimes: 3 });
    s.run.mockRejectedValue(new DigestError(message));

    await settle(s);

    expect(s.run).toHaveBeenCalledTimes(4);
    expect(s.onNoRecord).toHaveBeenCalledExactlyOnceWith(WEEK, lockNote);
    expect(s.onGiveUp).not.toHaveBeenCalled();
  });

  it('sends one note when no lock retry is configured', async () => {
    const s = setup({ lockTimes: 0 });
    s.run.mockRejectedValue(new DigestError(LOCK_HELD));

    await settle(s);

    expect(s.run).toHaveBeenCalledOnce();
    expect(s.onNoRecord).toHaveBeenCalledExactlyOnceWith(WEEK, lockNote);
  });

  it('hands over the earlier failure note instead, so the week gets one note', async () => {
    const s = setup({ lockTimes: 3 });
    const earlier = failed('first failure');
    s.run.mockResolvedValueOnce(earlier).mockRejectedValue(new DigestError(LOCK_HELD));

    await settle(s);

    expect(s.onGiveUp).toHaveBeenCalledExactlyOnceWith(WEEK, earlier);
    expect(s.onNoRecord).not.toHaveBeenCalled();
  });

  it('sends no lock note when stop() cancels the wait', async () => {
    const s = setup();
    s.run.mockRejectedValue(new DigestError(LOCK_HELD));

    const finished = runWithRetries(s.context, WEEK, 'schedule');
    await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);
    s.stop();
    await finished;

    expect(s.onNoRecord).not.toHaveBeenCalled();
  });

  it('sends the note of the budget that ran out last: a throw after lock misses', async () => {
    const s = setup({ lockTimes: 2, failedTimes: 1 });
    s.run
      .mockRejectedValueOnce(new DigestError(LOCK_HELD))
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockRejectedValueOnce(new DigestError(LOCK_HELD))
      .mockRejectedValue(new Error('disk gone'));

    await settle(s);

    expect(s.onNoRecord).toHaveBeenCalledExactlyOnceWith(
      WEEK,
      `The run for ${WEEK} stopped before it saved a record (Error).`,
    );
  });
});
