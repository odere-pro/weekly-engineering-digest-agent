import { describe, expect, it } from 'vitest';
import { ExitCode } from '../domain/schemas';
import { DigestError, FetchError } from '../shared/errors';
import { isLockHeldError, LOCK_HELD_MESSAGE } from './lockHeld';

describe('LOCK_HELD_MESSAGE', () => {
  it('is the text the stuck-lock runbook tells the operator to look for', () => {
    expect(LOCK_HELD_MESSAGE).toBe('Another run is in progress');
  });
});

describe('isLockHeldError', () => {
  it('recognises the error a store throws for a held lock, with its pid, host and week', () => {
    const error = new DigestError(`${LOCK_HELD_MESSAGE} (pid 4242, host box, week 2026-W42)`);

    expect(isLockHeldError(error)).toBe(true);
  });

  it('recognises a DigestError with the bare message, as other stores throw it', () => {
    expect(isLockHeldError(new DigestError(LOCK_HELD_MESSAGE))).toBe(true);
  });

  it('narrows the value to a DigestError', () => {
    const caught: unknown = new DigestError(LOCK_HELD_MESSAGE);

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
