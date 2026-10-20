import { describe, expect, it } from 'vitest';
import { DigestError, FetchError } from '../../shared/errors';
import { errorLabel, lockNote, threwNote } from './noRecordNote';

describe('errorLabel', () => {
  it('uses the errno code of a system error', () => {
    const error = Object.assign(new Error("EACCES: permission denied, open '/secret/run.json'"), {
      code: 'EACCES',
    });

    expect(errorLabel(error)).toBe('EACCES');
  });

  it('uses the class name of an error with no code', () => {
    expect(errorLabel(new DigestError('cannot read /Users/me/.env'))).toBe('DigestError');
    expect(errorLabel(new FetchError('HTTP 503', { retryable: true }))).toBe('FetchError');
    expect(errorLabel(new TypeError('x is not a function'))).toBe('TypeError');
  });

  it('uses the name when the code is not shaped like a code', () => {
    const error = Object.assign(new Error('boom'), { code: 'token=abc123 /etc/passwd' });

    expect(errorLabel(error)).toBe('Error');
  });

  it('uses the name when the code is not a string', () => {
    expect(errorLabel(Object.assign(new Error('boom'), { code: 5 }))).toBe('Error');
  });

  it('says "unknown error" for a name with a shape a note should not carry', () => {
    const error = new Error('boom');
    error.name = 'Error: password is hunter2';

    expect(errorLabel(error)).toBe('unknown error');
  });

  it.each([
    ['a string', 'token=abc123'],
    ['an object', { code: 'EIO', message: 'x' }],
    ['null', null],
    ['undefined', undefined],
  ])('says "unknown error" for %s, which is not an error', (_name, thrown) => {
    expect(errorLabel(thrown)).toBe('unknown error');
  });
});

describe('the notes', () => {
  it('names the week and the label of what the run threw', () => {
    expect(threwNote('2026-W42', 'EIO')).toBe(
      'The run for 2026-W42 stopped before it saved a record (EIO).',
    );
  });

  it('names the week whose run never started for the lock', () => {
    expect(lockNote('2026-W42')).toBe(
      'The run for 2026-W42 did not start: another run held the run lock for the whole retry budget.',
    );
  });
});
