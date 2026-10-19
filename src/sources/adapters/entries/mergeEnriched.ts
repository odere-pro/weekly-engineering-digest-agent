import type { Item, Source } from '../../../domain/schemas';
import { normalizeEntry } from './normalizeEntry';
import type { Pair, RawEntry } from './types';

/**
 * Puts the page text that enrichment found into the items. `enriched` lines up with `pairs`;
 * the text goes through the same normalization as feed text, and only the summary changes.
 */
export function mergeEnriched(
  enriched: readonly RawEntry[],
  pairs: readonly Pair[],
  source: Source,
  maxChars: number,
): Item[] {
  return pairs.map((pair, index) => {
    const entry = enriched[index];
    if (!entry || entry.text === pair.entry.text) return pair.item;
    const item = normalizeEntry(entry, source, { maxSummaryChars: maxChars });
    return item ? { ...pair.item, summary: item.summary } : pair.item;
  });
}
