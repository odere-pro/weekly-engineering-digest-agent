import { describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/types';
import { ExitCode } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';
import { waitToRetry } from './waitToRetry';
import type { Attempt, GiveUp, RetryContext, RetryKind, RetryWhere, SendNote } from './types';
import { budgetOf, type Waiter } from './wait';

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

const where: RetryWhere = { weekId: '2026-W42', trigger: 'schedule' };
const owed: RunResult = {
  record: makeRunRecord({ status: 'failed', error: { message: 'HTTP 503', step: 'deliver' } }),
  exitCode: ExitCode.Failed,
};

const failedAttempt: Extract<Attempt, { kind: 'failed' }> = { kind: 'failed', error: 'HTTP 503' };
const lockAttempt: Extract<Attempt, { kind: 'lock-held' }> = {
  kind: 'lock-held',
  error: 'Another run is in progress (pid 4242)',
};

const THREW_NOTE = 'The run for 2026-W42 stopped before it saved a record (EIO).';
const threwAttempt: Extract<Attempt, { kind: 'threw' }> = {
  kind: 'threw',
  error: 'EIO: i/o error',
  note: THREW_NOTE,
};
const LOCK_NOTE =
  'The run for 2026-W42 did not start: another run held the run lock for the whole retry budget.';

interface Setup {
  context: RetryContext;
  logger: MockLogger;
  wait: Mock<Waiter['wait']>;
  onGiveUp: Mock<GiveUp>;
  onNoRecord: Mock<SendNote>;
  stop: () => void;
}

/** Failed retries: 30 min, twice. Lock retries: 5 min, up to 2 h (24 tries). */
function setup(
  options: { waitResult?: boolean; stopped?: boolean; failedTimes?: number } = {},
): Setup {
  const { waitResult = true, stopped = false, failedTimes = 2 } = options;
  const logger = mockLogger();
  const onGiveUp = vi.fn<GiveUp>(() => Promise.resolve());
  const onNoRecord = vi.fn<SendNote>(() => Promise.resolve());
  const wait = vi.fn<Waiter['wait']>(() => Promise.resolve(waitResult));
  let isStopped = stopped;
  const context: RetryContext = {
    settings: {
      run: () => Promise.reject(new Error('not used')),
      logger,
      runTimeoutMs: 0,
      onGiveUp,
      onNoRecord,
    },
    budgets: {
      'lock-held': budgetOf(300_000, 24),
      failed: budgetOf(1_800_000, failedTimes),
    },
    timer: { wait, cancel: () => undefined, isWaiting: () => false },
    isStopped: () => isStopped,
  };
  return {
    context,
    logger,
    wait,
    onGiveUp,
    onNoRecord,
    stop: () => {
      isStopped = true;
    },
  };
}

const none = (): Record<RetryKind, number> => ({ 'lock-held': 0, failed: 0 });

describe('waitToRetry: a retry comes', () => {
  it('waits the budget of a failed run, counts the retry, and says so', async () => {
    const { context, logger, wait } = setup();
    const used = none();

    const retry = await waitToRetry(context, failedAttempt, used, undefined, where);

    expect(retry).toBe(true);
    expect(wait).toHaveBeenCalledExactlyOnceWith(1_800_000);
    expect(used).toEqual({ 'lock-held': 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('The run ended failed; will retry', {
      ...where,
      error: 'HTTP 503',
      retry: 1,
      ofMax: 2,
      inMs: 1_800_000,
      noteHeldBack: false,
    });
  });

  it('says the note is held back when an earlier attempt owes one', async () => {
    const { context, logger } = setup();

    await waitToRetry(context, failedAttempt, none(), owed, where);

    expect(logger.warn).toHaveBeenCalledWith(
      'The run ended failed; will retry',
      expect.objectContaining({ noteHeldBack: true }),
    );
  });

  it('counts the next retry from what is used', async () => {
    const { context, logger } = setup();

    await waitToRetry(context, failedAttempt, { 'lock-held': 0, failed: 1 }, undefined, where);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ retry: 2, ofMax: 2 }),
    );
  });

  it('waits five minutes for a held lock, on a budget of its own', async () => {
    const { context, logger, wait } = setup();
    const used = { 'lock-held': 3, failed: 2 };

    const retry = await waitToRetry(context, lockAttempt, used, undefined, where);

    expect(retry).toBe(true);
    expect(wait).toHaveBeenCalledExactlyOnceWith(300_000);
    expect(used).toEqual({ 'lock-held': 4, failed: 2 });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('Another run holds the lock; will retry', {
      ...where,
      error: 'Another run is in progress (pid 4242)',
      retry: 4,
      ofMax: 24,
      inMs: 300_000,
    });
  });

  it('adds noteHeldBack to a lock retry only when a note is owed', async () => {
    const { context, logger } = setup();

    await waitToRetry(context, lockAttempt, none(), owed, where);

    expect(logger.warn).toHaveBeenCalledWith(
      'Another run holds the lock; will retry',
      expect.objectContaining({ noteHeldBack: true }),
    );
  });
});

describe('waitToRetry: no retry is asked for', () => {
  it('returns false at once, silently, when failed retries are off', async () => {
    const { context, logger, wait, onGiveUp } = setup({ failedTimes: 0 });

    const retry = await waitToRetry(context, failedAttempt, none(), owed, where);

    expect(retry).toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe('waitToRetry: the budget is spent', () => {
  it('gives up on a run that kept failing, logs it, and hands the owed note over', async () => {
    const { context, logger, wait, onGiveUp } = setup();

    const retry = await waitToRetry(
      context,
      failedAttempt,
      { 'lock-held': 0, failed: 2 },
      owed,
      where,
    );

    expect(retry).toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Scheduled run gave up: the run kept failing',
      { ...where, error: 'HTTP 503', noteHeldBack: true, retries: 2 },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'the run kept failing' }),
    );
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', owed);
  });

  it('gives up on a lock that stayed held, with its own reason', async () => {
    const { context, logger, onGiveUp } = setup();

    const retry = await waitToRetry(
      context,
      lockAttempt,
      { 'lock-held': 24, failed: 0 },
      owed,
      where,
    );

    expect(retry).toBe(false);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Scheduled run gave up: another run kept the lock',
      { ...where, error: lockAttempt.error, noteHeldBack: true, retries: 24 },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'another run kept the lock' }),
    );
    expect(onGiveUp).toHaveBeenCalledWith('2026-W42', owed);
  });

  it('leaves noteHeldBack out of the give-up log when nothing is owed', async () => {
    const { context, logger, onGiveUp } = setup();

    await waitToRetry(context, failedAttempt, { 'lock-held': 0, failed: 2 }, undefined, where);

    expect(logger.error).toHaveBeenCalledWith('Scheduled run gave up: the run kept failing', {
      ...where,
      error: 'HTTP 503',
      retries: 2,
    });
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe('waitToRetry: the scheduler stops', () => {
  it('cancels without waiting when stop() came before, and hands the owed note over', async () => {
    const { context, logger, wait, onGiveUp } = setup({ stopped: true });

    const retry = await waitToRetry(context, failedAttempt, none(), owed, where);

    expect(retry).toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      'The run ended failed; will retry',
      expect.anything(),
    );
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('Retry cancelled: the scheduler stopped', {
      ...where,
      error: 'HTTP 503',
    });
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', owed);
  });

  it('is a cancel, not a give-up, when stop() came with the budget spent', async () => {
    const { context, logger } = setup({ stopped: true });

    await waitToRetry(context, failedAttempt, { 'lock-held': 0, failed: 2 }, owed, where);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Retry cancelled: the scheduler stopped', {
      ...where,
      error: 'HTTP 503',
    });
  });

  it('cancels when stop() cuts the wait short, and does not count the retry', async () => {
    const { context, logger, onGiveUp } = setup({ waitResult: false });
    const used = none();

    const retry = await waitToRetry(context, lockAttempt, used, owed, where);

    expect(retry).toBe(false);
    expect(used).toEqual(none());
    expect(logger.info).toHaveBeenCalledWith('Retry cancelled: the scheduler stopped', {
      ...where,
      error: lockAttempt.error,
    });
    expect(onGiveUp).toHaveBeenCalledWith('2026-W42', owed);
  });

  it('sends nothing on a cancel when nothing is owed', async () => {
    const { context, onGiveUp } = setup({ waitResult: false });

    await waitToRetry(context, failedAttempt, none(), undefined, where);

    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe('waitToRetry: a run that threw', () => {
  it('waits the failed budget, counts it there, and says the run threw', async () => {
    const { context, logger, wait } = setup();
    const used = none();

    const retry = await waitToRetry(context, threwAttempt, used, undefined, where);

    expect(retry).toBe(true);
    expect(wait).toHaveBeenCalledExactlyOnceWith(1_800_000);
    expect(used).toEqual({ 'lock-held': 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('The run threw an error; will retry', {
      ...where,
      error: 'EIO: i/o error',
      retry: 1,
      ofMax: 2,
      inMs: 1_800_000,
      noteHeldBack: false,
    });
  });

  it('gives up when the failed budget is spent, and sends its own note', async () => {
    const { context, logger, wait, onGiveUp, onNoRecord } = setup();

    const retry = await waitToRetry(
      context,
      threwAttempt,
      { 'lock-held': 0, failed: 2 },
      undefined,
      where,
    );

    expect(retry).toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Scheduled run gave up: the run kept throwing',
      { ...where, error: 'EIO: i/o error', retries: 2 },
    );
    expect(onNoRecord).toHaveBeenCalledExactlyOnceWith('2026-W42', THREW_NOTE);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('gives up at once, with a note, when failed retries are off', async () => {
    const { context, logger, wait, onNoRecord } = setup({ failedTimes: 0 });

    const retry = await waitToRetry(context, threwAttempt, none(), undefined, where);

    expect(retry).toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Scheduled run gave up: the run kept throwing',
      expect.objectContaining({ retries: 0 }),
    );
    expect(onNoRecord).toHaveBeenCalledExactlyOnceWith('2026-W42', THREW_NOTE);
  });

  it('hands over the owed failure note instead of its own', async () => {
    const { context, onGiveUp, onNoRecord } = setup();

    await waitToRetry(context, threwAttempt, { 'lock-held': 0, failed: 2 }, owed, where);

    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', owed);
    expect(onNoRecord).not.toHaveBeenCalled();
  });

  it('sends no note of its own when stop() cancels the retry', async () => {
    const { context, onNoRecord } = setup({ waitResult: false });

    await waitToRetry(context, threwAttempt, none(), undefined, where);

    expect(onNoRecord).not.toHaveBeenCalled();
  });
});

describe('waitToRetry: the lock budget is spent with nothing owed', () => {
  it('sends the lock note of the week', async () => {
    const { context, onGiveUp, onNoRecord } = setup();

    await waitToRetry(context, lockAttempt, { 'lock-held': 24, failed: 0 }, undefined, where);

    expect(onNoRecord).toHaveBeenCalledExactlyOnceWith('2026-W42', LOCK_NOTE);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('sends the owed failure note and not the lock note when one is owed', async () => {
    const { context, onGiveUp, onNoRecord } = setup();

    await waitToRetry(context, lockAttempt, { 'lock-held': 24, failed: 0 }, owed, where);

    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith('2026-W42', owed);
    expect(onNoRecord).not.toHaveBeenCalled();
  });

  it('sends no lock note when stop() cancels the wait', async () => {
    const { context, onNoRecord } = setup({ waitResult: false });

    await waitToRetry(context, lockAttempt, none(), undefined, where);

    expect(onNoRecord).not.toHaveBeenCalled();
  });

  it('sends no note for a failed run: its own run sent it', async () => {
    const { context, onNoRecord } = setup();

    await waitToRetry(context, failedAttempt, { 'lock-held': 0, failed: 2 }, undefined, where);

    expect(onNoRecord).not.toHaveBeenCalled();
  });
});
