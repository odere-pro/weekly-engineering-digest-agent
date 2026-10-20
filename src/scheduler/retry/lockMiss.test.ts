import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DigestError, FetchError } from '../../shared/errors';
import { isLockMissError, LOCK_MISS_MESSAGE } from './lockMiss';

describe('LOCK_MISS_MESSAGE', () => {
  it('is the text the lock adapter throws, so a change there fails here', () => {
    const adapter = readFileSync(
      fileURLToPath(new URL('../../store/adapters/runLock.ts', import.meta.url)),
      'utf8',
    );

    expect(adapter).toContain(`new DigestError('${LOCK_MISS_MESSAGE}: another run is starting')`);
  });
});

describe('isLockMissError', () => {
  it('recognises the error acquireRunLock throws after three lost races', () => {
    const error = new DigestError('Could not take the run lock: another run is starting');

    expect(isLockMissError(error)).toBe(true);
  });

  it('accepts a subclass of DigestError with the same message', () => {
    expect(isLockMissError(new FetchError(LOCK_MISS_MESSAGE, { retryable: false }))).toBe(true);
  });

  it.each([
    ['a DigestError about something else', new DigestError('Ollama is not reachable')],
    ['a DigestError that only mentions the lock', new DigestError(`Oops: ${LOCK_MISS_MESSAGE}`)],
    ['a held lock', new DigestError('Another run is in progress (pid 4242)')],
    ['a plain Error with the same text', new Error(LOCK_MISS_MESSAGE)],
    ['a string with the same text', LOCK_MISS_MESSAGE],
    ['an object with the same message', { message: LOCK_MISS_MESSAGE }],
    ['undefined', undefined],
  ])('does not take %s for a lock miss', (_name, error) => {
    expect(isLockMissError(error)).toBe(false);
  });
});
