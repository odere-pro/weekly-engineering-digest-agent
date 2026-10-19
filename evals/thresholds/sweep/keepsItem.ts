// The keep test the sweep scores a threshold set with. It repeats the three threshold rules of
// the process step (src/process/process.ts, filterStages), so the two must change together:
// keepsItem.test.ts runs both on a table of items and fails when they disagree.
import type { Thresholds } from '../../../src/config/schema';
import type { Classified } from '../capture/schemas';

export type FilterThresholds = Pick<Thresholds, 'minRelevance' | 'maxHype' | 'maxMinorRelease'>;

/** Keep when relevance is at least minRelevance and hype and minorRelease are at most their caps. */
export function keepsItem(
  scores: Pick<Classified, 'relevance' | 'hype' | 'minorRelease'>,
  thresholds: FilterThresholds,
): boolean {
  return (
    scores.relevance >= thresholds.minRelevance &&
    scores.hype <= thresholds.maxHype &&
    scores.minorRelease <= thresholds.maxMinorRelease
  );
}
