import { describe, expect, it } from 'vitest';
import { spearman, type RankPair } from './spearman';

const pairs = (...values: [number, number][]): RankPair[] =>
  values.map(([expected, actual]) => ({ expected, actual }));

describe('spearman', () => {
  it('is 1 for the same order and -1 for the reverse order', () => {
    expect(spearman(pairs([0, 0.2], [1, 1.1], [2, 2.5], [3, 2.9]))).toBeCloseTo(1);
    expect(spearman(pairs([0, 3], [1, 2], [2, 1], [3, 0]))).toBeCloseTo(-1);
  });

  it('gives tied values their average rank', () => {
    // labels 0,0,1,1 vs predictions 0,1,1,1: hand-computed rho = 0.57735...
    expect(spearman(pairs([0, 0], [0, 1], [1, 1], [1, 1]))).toBeCloseTo(Math.sqrt(1 / 3), 5);
  });

  it('does not depend on the order the pairs come in', () => {
    const forward = spearman(pairs([0, 1], [1, 0], [2, 2], [3, 3], [3, 2]));
    const shuffled = spearman(pairs([3, 2], [0, 1], [3, 3], [2, 2], [1, 0]));

    expect(forward).not.toBeNull();
    expect(shuffled).toBeCloseTo(forward ?? Number.NaN, 10);
  });

  it('is null when one side has no spread', () => {
    expect(spearman(pairs([0, 1], [1, 1], [2, 1]))).toBeNull();
    expect(spearman(pairs([4, 1], [4, 2], [4, 3]))).toBeNull();
  });

  it('is null for fewer than two pairs', () => {
    expect(spearman(pairs([1, 0]))).toBeNull();
    expect(spearman([])).toBeNull();
  });
});
