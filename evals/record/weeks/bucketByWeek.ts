import type { Item } from '../../../src/domain/schemas';
import { isoWeekId } from '../../../src/shared/isoWeek';

/** Groups items by the ISO week (UTC) they were published in. Items outside `weekIds` are dropped. */
export function bucketByWeek(
  items: readonly Item[],
  weekIds: readonly string[],
): Map<string, Item[]> {
  const buckets = new Map<string, Item[]>(weekIds.map((weekId) => [weekId, []]));
  for (const item of items) {
    buckets.get(isoWeekId(new Date(item.publishedAt)))?.push(item);
  }
  return buckets;
}
