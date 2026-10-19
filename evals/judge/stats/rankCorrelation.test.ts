import { describe, expect, it } from 'vitest';
import { pairs } from '../__fixtures__/sheetKit';
import { averageRanks, pearson, spearman } from './rankCorrelation';

describe('averageRanks', () => {
  it('ranks from 1 for the smallest value', () => {
    expect(averageRanks([30, 10, 20])).toEqual([3, 1, 2]);
  });

  it('gives equal values the mean of the ranks they span', () => {
    expect(averageRanks([5, 5, 7, 7, 7, 1])).toEqual([2.5, 2.5, 5, 5, 5, 1]);
  });

  it('is empty for no values', () => {
    expect(averageRanks([])).toEqual([]);
  });
});

describe('pearson', () => {
  it('is 1 for a straight line and -1 for a falling one', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1);
  });

  it('is 0 for values that do not move together', () => {
    expect(pearson([1, 2, 3, 4], [2, 1, 1, 2])).toBeCloseTo(0);
  });

  it('is null for fewer than two points', () => {
    expect(pearson([1], [1])).toBeNull();
    expect(pearson([], [])).toBeNull();
  });

  it('is null when either side never changes, since the spread is 0', () => {
    expect(pearson([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it('stays within -1 for a perfect falling relation, whatever the rounding does', () => {
    const xs = [0.1, 0.2, 0.3, 0.7, 0.9];
    const ys = xs.map((x) => -x * 3.3);

    const value = pearson(xs, ys);

    expect(value).toBeGreaterThanOrEqual(-1);
    expect(value).toBeLessThan(-0.999999);
  });

  it('stays within 1 for a perfect linear relation, whatever the rounding does', () => {
    const xs = [0.1, 0.2, 0.3, 0.7, 0.9];
    const ys = xs.map((x) => x * 3.3);

    const value = pearson(xs, ys);

    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBeGreaterThan(0.999999);
  });
});

describe('spearman', () => {
  it('is 1 for the same order, whatever the distances', () => {
    expect(spearman(pairs([1, 2, 3, 4], [2, 3, 4, 5]))).toBeCloseTo(1);
    expect(spearman(pairs([1, 2, 3, 4], [1, 1.1, 4.9, 5]))).toBeCloseTo(1);
  });

  it('is -1 for the opposite order', () => {
    expect(spearman(pairs([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]))).toBeCloseTo(-1);
  });

  it('matches the textbook value for a swap of two neighbours', () => {
    // d = [0, 0, 0, 1, -1]: 1 - 6 * 2 / (5 * 24) = 0.9
    expect(spearman(pairs([1, 2, 3, 4, 5], [1, 2, 3, 5, 4]))).toBeCloseTo(0.9);
  });

  it('gives tied values the mean of their ranks', () => {
    // ranks: human [1.5, 1.5, 3.5, 3.5], judge [1.5, 3.5, 1.5, 3.5]: no correlation.
    expect(spearman(pairs([1, 1, 2, 2], [1, 2, 1, 2]))).toBeCloseTo(0);
    // ranks: human [1.5, 1.5, 3, 4], judge [1, 2, 3, 4]
    expect(spearman(pairs([1, 1, 2, 3], [1, 2, 3, 4]))).toBeCloseTo(0.9487, 3);
  });

  it('is null when one side never changes, since the correlation is undefined', () => {
    expect(spearman(pairs([3, 3, 3], [1, 2, 3]))).toBeNull();
    expect(spearman(pairs([1, 2, 3], [4, 4, 4]))).toBeNull();
  });

  it('is null for fewer than two pairs', () => {
    expect(spearman(pairs([3], [3]))).toBeNull();
    expect(spearman([])).toBeNull();
  });

  it('does not change the pairs it is given', () => {
    const given = pairs([3, 1, 2], [2, 3, 1]);
    const before = structuredClone(given);

    spearman(given);

    expect(given).toEqual(before);
  });
});
