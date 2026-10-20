import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunResult } from '../../digest/types';
import { RecordNotSavedError } from '../../digest/ending/saveRecord';
import { ExitCode, type RunStatus } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';
import { HOUR_MS } from '../timing';
import { afterRun, attemptRun } from './attemptRun';
import type { AttemptSettings, RunWeek } from './types';

const FORCE_MESSAGE =
  'digest.md no longer matches the digest markdown got; run with --force to send a new digest';
const ABORTED_MESSAGE = 'Run aborted before the write step: run timed out after 3 h';

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

afterEach(() => {
  vi.useRealTimers();
});

function settingsFor(
  run: RunWeek,
  runTimeoutMs = 3 * HOUR_MS,
): Omit<AttemptSettings, 'logger'> & { logger: MockLogger } {
  return { run, logger: mockLogger(), runTimeoutMs };
}

describe('attemptRun', () => {
  it('runs the week with a fresh signal and the attempt it was given', async () => {
    const run = vi.fn<RunWeek>(() => Promise.resolve(sent));

    await attemptRun(settingsFor(run), '2026-W42', 'schedule', { notifyFailure: false });

    expect(run).toHaveBeenCalledExactlyOnceWith('2026-W42', expect.any(AbortSignal), {
      notifyFailure: false,
    });
    expect(run.mock.calls[0]?.[1].aborted).toBe(false);
  });

  it('is finished, and logs how the run ended, when the run did not fail', async () => {
    const settings = settingsFor(() => Promise.resolve(sent));

    const attempt = await attemptRun(settings, '2026-W42', 'catch-up', { notifyFailure: true });

    expect(attempt).toEqual({ kind: 'finished' });
    expect(settings.logger.info).toHaveBeenCalledExactlyOnceWith('Scheduled run finished', {
      weekId: '2026-W42',
      trigger: 'catch-up',
      status: 'sent',
      exitCode: ExitCode.Sent,
    });
  });

  it('reports a failed run with its error, and owes nothing when it sent its own note', async () => {
    const settings = settingsFor(() => Promise.resolve(failed()));

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(attempt).toEqual({
      kind: 'failed',
      error: 'Slack webhook answered HTTP 503',
      owed: undefined,
    });
  });

  it('owes the failed result when the run was told to hold its note back', async () => {
    const result = failed();
    const settings = settingsFor(() => Promise.resolve(result));

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: false });

    expect(attempt).toEqual({ kind: 'failed', error: result.record.error?.message, owed: result });
  });

  it('says the lock is held when the run throws the store error for it', async () => {
    const settings = settingsFor(() =>
      Promise.reject(new DigestError('Another run is in progress (pid 4242)')),
    );

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(attempt).toEqual({
      kind: 'lock-held',
      error: 'Another run is in progress (pid 4242)',
    });
    expect(settings.logger.error).not.toHaveBeenCalled();
  });

  it('says the lock is held when the lock adapter lost every race for it', async () => {
    const settings = settingsFor(() =>
      Promise.reject(new DigestError('Could not take the run lock: another run is starting')),
    );

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(attempt).toEqual({
      kind: 'lock-held',
      error: 'Could not take the run lock: another run is starting',
    });
    expect(settings.logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ['Another run is in progress'],
    ['Could not take the run lock: another run is starting'],
  ])('does not take a plain Error saying "%s" for a held lock', async (text) => {
    const settings = settingsFor(() => Promise.reject(new Error(text)));

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(attempt.kind).toBe('threw');
  });

  it('logs any other error the run throws and carries the note the week owes for it', async () => {
    const settings = settingsFor(() => Promise.reject(new Error('disk gone')));

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(attempt).toEqual({
      kind: 'threw',
      error: 'disk gone',
      note: 'The run for 2026-W42 stopped before it saved a record (Error).',
    });
    expect(settings.logger.error).toHaveBeenCalledExactlyOnceWith('Scheduled run failed', {
      weekId: '2026-W42',
      trigger: 'schedule',
      error: 'disk gone',
    });
  });

  it('puts the errno code in the note, and none of the message', async () => {
    const eio = Object.assign(new Error("EIO: i/o error, read '/data/dist/run.json'"), {
      code: 'EIO',
    });
    const settings = settingsFor(() => Promise.reject(eio));

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(attempt).toMatchObject({
      kind: 'threw',
      note: 'The run for 2026-W42 stopped before it saved a record (EIO).',
    });
  });

  it('is noted, with no note owed, when the run could not save its record and said so', async () => {
    const settings = settingsFor(() => Promise.reject(new RecordNotSavedError('no space')));

    const attempt = await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(attempt).toEqual({ kind: 'noted' });
  });

  it('reports a throw after the time limit fired as timed out, which nobody retries', async () => {
    vi.useFakeTimers();
    const settings = settingsFor(
      (_weekId, signal) =>
        new Promise<RunResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('lost the store'));
          });
        }),
      HOUR_MS,
    );

    const pending = attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    const attempt = await pending;

    expect(attempt).toEqual({
      kind: 'timed-out',
      note: 'The run for 2026-W42 stopped before it saved a record (Error).',
    });
  });

  it('logs the time limit, aborts the run, and reports a timed-out attempt', async () => {
    vi.useFakeTimers();
    const run = vi.fn<RunWeek>(
      (_weekId, signal) =>
        new Promise<RunResult>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve(failed(ABORTED_MESSAGE));
          });
        }),
    );
    const settings = settingsFor(run, HOUR_MS);

    const pending = attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    const attempt = await pending;

    expect(attempt).toEqual({ kind: 'timed-out', owed: undefined });
    expect(settings.logger.error).toHaveBeenCalledExactlyOnceWith(
      'Scheduled run hit its time limit; asking it to stop',
      { weekId: '2026-W42', trigger: 'schedule', limitMs: HOUR_MS },
    );
  });

  it('leaves no timer behind after a run that finished or threw', async () => {
    vi.useFakeTimers();

    await attemptRun(
      settingsFor(() => Promise.resolve(sent)),
      'w',
      'schedule',
      {
        notifyFailure: true,
      },
    );
    await attemptRun(
      settingsFor(() => Promise.reject(new Error('boom'))),
      'w',
      'schedule',
      {
        notifyFailure: true,
      },
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('sets no time limit when runTimeoutMs is zero', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const settings = settingsFor((_weekId, runSignal) => {
      signal = runSignal;
      return Promise.resolve(sent);
    }, 0);

    await attemptRun(settings, '2026-W42', 'schedule', { notifyFailure: true });

    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('afterRun', () => {
  const where = { weekId: '2026-W42', trigger: 'schedule' as const };

  it.each<RunStatus>(['sent', 'quiet', 'blocked', 'dry-run', 'skipped'])(
    'is finished for a run that ended %s',
    (status) => {
      const logger = mockLogger();

      const attempt = afterRun(logger, resultWith(status), {
        ...where,
        timedOut: false,
        notifyFailure: false,
      });

      expect(attempt).toEqual({ kind: 'finished' });
    },
  );

  it('retries a failure that has no recorded error, under a generic reason', () => {
    const attempt = afterRun(mockLogger(), resultWith('failed'), {
      ...where,
      timedOut: false,
      notifyFailure: true,
    });

    expect(attempt).toEqual({ kind: 'failed', error: 'The run ended failed', owed: undefined });
  });

  it('owes a failure that held its note back, and none that sent it', () => {
    const result = failed();
    const base = { ...where, timedOut: false };

    expect(afterRun(mockLogger(), result, { ...base, notifyFailure: false })).toMatchObject({
      kind: 'failed',
      owed: result,
    });
    expect(afterRun(mockLogger(), result, { ...base, notifyFailure: true })).toMatchObject({
      kind: 'failed',
      owed: undefined,
    });
  });

  it('is timed out for a run that hit the limit, and logs that it will not retry', () => {
    const logger = mockLogger();
    const result = failed(ABORTED_MESSAGE);

    const attempt = afterRun(logger, result, { ...where, timedOut: true, notifyFailure: true });

    expect(attempt).toEqual({ kind: 'timed-out', owed: undefined });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Not retrying a run that hit its time limit',
      where,
    );
  });

  it('owes a timed-out run only when its note was held back and is not already sent', () => {
    const retriable = failed('the model hung');
    const aborted = failed(ABORTED_MESSAGE);
    const base = { ...where, timedOut: true, notifyFailure: false };

    expect(afterRun(mockLogger(), retriable, base)).toEqual({
      kind: 'timed-out',
      owed: retriable,
    });
    // A run the limit stopped sends its own note whatever it was told.
    expect(afterRun(mockLogger(), aborted, base)).toEqual({ kind: 'timed-out', owed: undefined });
  });

  it('is finished, with a warning, for a failure only --force can clear', () => {
    const logger = mockLogger();

    const attempt = afterRun(logger, failed(FORCE_MESSAGE), {
      ...where,
      timedOut: false,
      notifyFailure: false,
    });

    expect(attempt).toEqual({ kind: 'finished' });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Not retrying: finishing this week needs "digest run --force"',
      { ...where, error: FORCE_MESSAGE },
    );
  });
});
