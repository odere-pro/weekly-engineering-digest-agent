import { describe, expect, it } from 'vitest';
import { pairs } from '../__fixtures__/sheetKit';
import { meanAbsoluteDifference } from './meanAbsoluteDifference';

describe('meanAbsoluteDifference', () => {
  it('is the mean distance between grade and score', () => {
    expect(meanAbsoluteDifference(pairs([4, 3, 5], [3.5, 3, 3]))).toBeCloseTo((0.5 + 0 + 2) / 3);
  });

  it('is null without pairs', () => {
    expect(meanAbsoluteDifference([])).toBeNull();
  });

  it('counts a judge that scores above and one that scores below the same', () => {
    expect(meanAbsoluteDifference(pairs([3, 3], [4, 2]))).toBe(1);
  });

  it('is 0 when the judge scores exactly as the maintainer graded', () => {
    expect(meanAbsoluteDifference(pairs([2, 5], [2, 5]))).toBe(0);
  });
});
