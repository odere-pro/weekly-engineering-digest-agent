import { mean } from './mean';
import type { GradePair } from './types';

/** Rank of each value, 1 for the smallest; equal values share the mean of their ranks. */
export function averageRanks(values: readonly number[]): number[] {
  return values.map((value) => {
    const below = values.filter((other) => other < value).length;
    const equal = values.filter((other) => other === value).length;
    return below + (equal + 1) / 2;
  });
}

/** Linear correlation of two lists of one length, -1 to 1; null when it is undefined. */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  const sxy = xs.reduce((sum, x, i) => sum + (x - mx) * ((ys[i] ?? 0) - my), 0);
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const syy = ys.reduce((sum, y) => sum + (y - my) ** 2, 0);
  if (sxx === 0 || syy === 0) return null;
  // Rounding can push a perfect correlation a hair past 1.
  return Math.min(1, Math.max(-1, sxy / Math.sqrt(sxx * syy)));
}

/**
 * Rank correlation of the hand grades and the judge scores, -1 to 1. Null when it is undefined:
 * fewer than two pairs, or one side never changes.
 */
export function spearman(pairs: readonly GradePair[]): number | null {
  return pearson(averageRanks(pairs.map((p) => p.human)), averageRanks(pairs.map((p) => p.judge)));
}
