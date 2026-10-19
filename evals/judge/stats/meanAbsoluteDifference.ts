import { mean } from './mean';
import type { GradePair } from './types';

/** Mean distance between a hand grade and the judge's score, in points; null without pairs. */
export function meanAbsoluteDifference(pairs: readonly GradePair[]): number | null {
  return pairs.length === 0 ? null : mean(pairs.map((p) => Math.abs(p.judge - p.human)));
}
