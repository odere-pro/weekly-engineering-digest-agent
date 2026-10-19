import { normalizeText } from '../normalizeText';
import type { Entry } from '../types';

/** No area takes more than this many slots while another area still has an item to place. */
const MAX_SLOTS_PER_AREA = 2;

/**
 * Greedy pick from a ranked list. Areas under the slot cap compete on rank alone; once every
 * remaining item is in a full area, the least-filled area goes first, then rank.
 */
export function pickWithAreaSpread(ranked: readonly Entry[], topN: number): Set<Entry> {
  const chosen = new Set<Entry>();
  const slotsByArea = new Map<string, number>();
  const areaOf = (entry: Entry): string => normalizeText(entry.item.classification.area);
  // Everything under the cap shares pressure 0, so rank decides among those.
  const pressure = (entry: Entry): number => {
    const used = slotsByArea.get(areaOf(entry)) ?? 0;
    return used < MAX_SLOTS_PER_AREA ? 0 : used;
  };

  while (chosen.size < Math.min(topN, ranked.length)) {
    const remaining = ranked.filter((entry) => !chosen.has(entry));
    const best = remaining.reduce((a, b) => (pressure(b) < pressure(a) ? b : a));
    chosen.add(best);
    slotsByArea.set(areaOf(best), (slotsByArea.get(areaOf(best)) ?? 0) + 1);
  }
  return chosen;
}
