import type { Source } from '../../../domain/schemas';
import type { FetchWindow } from '../../SourceFetcher';
import { normalizeEntry } from './normalizeEntry';
import type { Pair } from './types';

/**
 * Some feeds (Google Cloud release notes) give every entry the same link, which would make
 * them one item. Entries that share a link, as dedupe sees it, get the feed's own entry id as a
 * query parameter. The whole feed decides, not the window, so an entry keeps its URL from week
 * to week while the feed keeps repeating that link.
 */
export function withDistinctLinks(
  pairs: readonly Pair[],
  source: Source,
  maxChars: number,
): Pair[] {
  const uses = new Map<string, number>();
  for (const { item } of pairs) uses.set(item.id, (uses.get(item.id) ?? 0) + 1);
  return pairs.map((pair) => {
    if ((uses.get(pair.item.id) ?? 0) < 2) return pair;
    const item = normalizeEntry(pair.entry, source, {
      maxSummaryChars: maxChars,
      distinctLink: true,
    });
    return item ? { entry: pair.entry, item } : pair;
  });
}

function isInWindow({ item }: Pair, window: FetchWindow): boolean {
  const publishedMs = Date.parse(item.publishedAt);
  return publishedMs >= window.since.getTime() && publishedMs <= window.until.getTime();
}

const newestFirst = (a: Pair, b: Pair): number =>
  Date.parse(b.item.publishedAt) - Date.parse(a.item.publishedAt);

/**
 * The entries a source keeps: shared links told apart first, then only those inside the window,
 * newest first, at most `window.maxItems`. Page enrichment runs on this list, so the cap also
 * bounds the pages that are fetched.
 */
export function selectEntries(
  pairs: readonly Pair[],
  source: Source,
  window: FetchWindow,
  maxChars: number,
): Pair[] {
  return withDistinctLinks(pairs, source, maxChars)
    .filter((pair) => isInWindow(pair, window))
    .sort(newestFirst)
    .slice(0, window.maxItems);
}
