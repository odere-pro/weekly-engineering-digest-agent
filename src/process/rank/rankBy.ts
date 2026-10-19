import type { ScoredItem } from '../../classify/classification';
import type { Entry } from '../types';

/** Ranks by `byRank`, except that ids in `order` come first, in that order (W11-07). */
export function rankBy(order: readonly string[] | undefined): (a: Entry, b: Entry) => number {
  if (order === undefined) return byRank;
  const position = new Map(order.map((id, index) => [id, index]));
  const at = (entry: Entry): number => position.get(entry.item.id) ?? Number.POSITIVE_INFINITY;
  return (a, b) => {
    const pa = at(a);
    const pb = at(b);
    if (pa === pb) return byRank(a, b);
    return pa < pb ? -1 : 1;
  };
}

/**
 * Relevance desc, areaConfidence desc, publishedAt desc, id asc. Source, title and URL only
 * settle ties between items that share an id, so the winner never depends on input order.
 */
export function byRank(a: Entry, b: Entry): number {
  const ca = a.item.classification;
  const cb = b.item.classification;
  return (
    cb.relevance - ca.relevance ||
    cb.areaConfidence - ca.areaConfidence ||
    publishedMs(b.item) - publishedMs(a.item) ||
    compareStrings(a.item.id, b.item.id) ||
    compareStrings(a.item.sourceId, b.item.sourceId) ||
    compareStrings(a.item.title, b.item.title) ||
    compareStrings(a.item.url, b.item.url)
  );
}

/** Publication instant in ms; an unparseable date counts as the oldest. */
function publishedMs(item: ScoredItem): number {
  const ms = Date.parse(item.publishedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Plain code-unit order, so the result does not depend on the machine's locale. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
