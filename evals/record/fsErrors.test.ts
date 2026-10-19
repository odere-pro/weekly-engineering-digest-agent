import { describe, expect, it } from 'vitest';
import { hasErrorCode } from './fsErrors';

const withCode = (code: string): Error => Object.assign(new Error('failed'), { code });

describe('hasErrorCode', () => {
  it('is true for an error with that code', () => {
    expect(hasErrorCode(withCode('ENOENT'), 'ENOENT')).toBe(true);
  });

  it('is false for an error with another code or none', () => {
    expect(hasErrorCode(withCode('EEXIST'), 'ENOENT')).toBe(false);
    expect(hasErrorCode(new Error('failed'), 'ENOENT')).toBe(false);
  });

  it('is false for a value that is not an error, even with a matching code', () => {
    expect(hasErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false);
    expect(hasErrorCode('ENOENT', 'ENOENT')).toBe(false);
    expect(hasErrorCode(undefined, 'ENOENT')).toBe(false);
  });
});
