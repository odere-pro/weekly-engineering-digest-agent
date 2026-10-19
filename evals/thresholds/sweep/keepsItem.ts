// The keep test the sweep scores a threshold set with: the process step's own rule
// (`passesThresholds` in src/process/filter/thresholds.ts), so the sweep and the pipeline cannot
// disagree. keepsItem.test.ts still runs processStep on a table of items to pin it.
import { passesThresholds, type ThresholdLimits } from '../../../src/process/filter/thresholds';
import type { Classified } from '../capture/schemas';

export type FilterThresholds = ThresholdLimits;

/** Keep when relevance is at least minRelevance and hype and minorRelease are at most their caps. */
export function keepsItem(
  scores: Pick<Classified, 'relevance' | 'hype' | 'minorRelease'>,
  thresholds: FilterThresholds,
): boolean {
  return passesThresholds(scores, thresholds);
}
