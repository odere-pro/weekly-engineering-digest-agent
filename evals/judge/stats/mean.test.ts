import { describe, expect, it } from 'vitest';
import { mean } from './mean';

describe('mean', () => {
  it('is the sum divided by the count', () => {
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([4])).toBe(4);
  });

  it('keeps a fraction', () => {
    expect(mean([1, 2])).toBe(1.5);
  });

  it('is NaN for no values, so a caller that forgot the empty case cannot report a number', () => {
    expect(mean([])).toBeNaN();
  });
});
