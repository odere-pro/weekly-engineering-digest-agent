import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../../domain/schemas';
import { DigestError, FetchError } from '../../../shared/errors';
import { isLockHeldError, LOCK_HELD_MESSAGE, lockHeldError } from './lockHeldError';

const NOW = '2026-01-05T08:00:00.000Z';

describe('lockHeldError', () => {
  it('names the pid, the host and the week of the run that holds the lock', () => {
    const error = lockHeldError({ pid: 4242, runId: '2026-W42', startedAt: NOW, hostname: 'box' });

    expect(error).toBeInstanceOf(DigestError);
    expect(error.message).toBe('Another run is in progress (pid 4242, host box, week 2026-W42)');
  });

  it('leaves the host out for a legacy lock that names none', () => {
    const error = lockHeldError({ pid: 4242, runId: '2026-W41', startedAt: NOW });

    expect(error.message).toBe('Another run is in progress (pid 4242, week 2026-W41)');
  });

  it('exits with the plain failure code', () => {
    const error = lockHeldError({ pid: 1, runId: '2026-W42', startedAt: NOW });

    expect(error.exitCode).toBe(ExitCode.Failed);
  });

  it('starts with the shared message text', () => {
    const error = lockHeldError({ pid: 1, runId: '2026-W42', startedAt: NOW });

    expect(error.message.startsWith(LOCK_HELD_MESSAGE)).toBe(true);
  });
});

describe('LOCK_HELD_MESSAGE', () => {
  it('is the text the stuck-lock runbook tells the operator to look for', () => {
    expect(LOCK_HELD_MESSAGE).toBe('Another run is in progress');
  });
});

describe('isLockHeldError', () => {
  it('recognises what the run lock throws', () => {
    const error = lockHeldError({ pid: 4242, runId: '2026-W42', startedAt: NOW, hostname: 'box' });

    expect(isLockHeldError(error)).toBe(true);
  });

  it('recognises a DigestError with the bare message, as other stores throw it', () => {
    expect(isLockHeldError(new DigestError(LOCK_HELD_MESSAGE))).toBe(true);
  });

  it('narrows the value to a DigestError', () => {
    const caught: unknown = lockHeldError({ pid: 1, runId: '2026-W42', startedAt: NOW });

    if (!isLockHeldError(caught)) throw new Error('expected a lock-held error');

    expect(caught.exitCode).toBe(ExitCode.Failed);
  });

  it('accepts a subclass of DigestError with the same message', () => {
    expect(isLockHeldError(new FetchError(LOCK_HELD_MESSAGE, { retryable: false }))).toBe(true);
  });

  it.each([
    ['a DigestError about something else', new DigestError('Could not take the run lock')],
    ['a DigestError that only mentions the lock', new DigestError(`Oops: ${LOCK_HELD_MESSAGE}`)],
    ['a plain Error with the same text', new Error(LOCK_HELD_MESSAGE)],
    ['a string with the same text', LOCK_HELD_MESSAGE],
    ['an object with the same message', { message: LOCK_HELD_MESSAGE }],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isLockHeldError(value)).toBe(false);
  });
});
