import { describe, expect, it } from 'vitest';
import { classifyError } from './classifyError';
import { DigestError } from '../../shared/errors';

describe('classifyError', () => {
  it('is a DigestError of step classify with the message prefixed', () => {
    const error = classifyError('chose area "x" for item i-1, which is not an option');

    expect(error).toBeInstanceOf(DigestError);
    expect(error.step).toBe('classify');
    expect(error.message).toBe('classify: chose area "x" for item i-1, which is not an option');
  });
});
