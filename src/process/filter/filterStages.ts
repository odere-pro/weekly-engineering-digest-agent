import type { Thresholds } from '../../config/schema';
import { duplicates } from '../dedupe/duplicates';
import { sentBefore } from '../dedupe/sentBefore';
import type { DropReason, Entry } from '../types';
import type { Stage } from './applyStage';
import { failedThreshold, THRESHOLD_REASONS } from './thresholds';

/**
 * The drop rules in the order the contract applies them; an item gets the first reason that fits.
 * `sent-before` and `duplicate` come first, then one stage per threshold rule.
 */
export function filterStages(sentUrls: ReadonlySet<string>, thresholds: Thresholds): Stage[] {
  const perItem = (reason: DropReason, test: (entry: Entry) => boolean): Stage => ({
    reason,
    drops: () => test,
  });
  return [
    perItem('sent-before', sentBefore(sentUrls)),
    { reason: 'duplicate', drops: duplicates },
    ...THRESHOLD_REASONS.map((reason) =>
      perItem(reason, ({ item }) => failedThreshold(item.classification, thresholds) === reason),
    ),
  ];
}
