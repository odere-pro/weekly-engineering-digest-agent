import { describe, expect, it } from 'vitest';
import { errorCode, isNotFound } from './errorCode';

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('errorCode', () => {
  it('returns the code of a system error', () => {
    expect(errorCode(errno('EACCES'))).toBe('EACCES');
  });

  it('returns undefined for an error without a code', () => {
    expect(errorCode(new Error('plain'))).toBeUndefined();
  });

  it('returns undefined when the code is not a string', () => {
    expect(errorCode(Object.assign(new Error('odd'), { code: 13 }))).toBeUndefined();
  });

  it('returns undefined for a value that is not an Error', () => {
    expect(errorCode({ code: 'ENOENT' })).toBeUndefined();
    expect(errorCode('ENOENT')).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });
});

describe('isNotFound', () => {
  it('is true only for ENOENT', () => {
    expect(isNotFound(errno('ENOENT'))).toBe(true);
    expect(isNotFound(errno('ENOTDIR'))).toBe(false);
    expect(isNotFound(new Error('ENOENT'))).toBe(false);
  });
});
