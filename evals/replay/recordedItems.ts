import { SourceKindSchema, type Item, type Source } from '../../src/domain/schemas';
import type { DigestDeps } from '../../src/digest/runDigest';
import type { FetchWindow } from '../../src/sources/SourceFetcher';
import { weekStartUtc } from '../../src/shared/isoWeek';

const DAY_MS = 86_400_000;
/** Recorded weeks are ISO weeks, so each replay collects exactly one week. */
export const WEEK_DAYS = 7;

/** Like the real fetchers: a source's newest items first. */
export function newestFirst(items: readonly Item[]): Item[] {
  return items.toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/**
 * The ids a replay serves: each source's newest items up to the cap production applies to it,
 * `maxItems` of its own else `maxItemsPerSource`. A label outside this set is "not visible".
 */
export function servedIds(
  items: readonly Item[],
  sources: readonly Source[],
  maxItemsPerSource: number,
): Set<string> {
  const served = new Set<string>();
  for (const sourceId of new Set(items.map((item) => item.sourceId))) {
    const cap = sources.find((source) => source.id === sourceId)?.maxItems ?? maxItemsPerSource;
    const own = items.filter((item) => item.sourceId === sourceId);
    for (const item of newestFirst(own).slice(0, cap)) served.add(item.id);
  }
  return served;
}

/** The week's end: the replay clock, so the collect window is exactly the recorded week. */
export function endOfWeek(weekId: string): Date {
  return new Date(weekStartUtc(weekId).getTime() + WEEK_DAYS * DAY_MS - 1);
}

/**
 * One source per source id found in the recorded items; the url is never fetched. A source
 * keeps the `maxItems` the allowlist gives it, and one with none falls back to the config's
 * `maxItemsPerSource`, so the cap is production's own.
 */
export function sourcesOf(items: readonly Item[], allowlist: readonly Source[]): Source[] {
  const firstOfSource = new Map(items.map((item) => [item.sourceId, item]));
  return [...firstOfSource.values()].map((item) => {
    const maxItems = allowlist.find((source) => source.id === item.sourceId)?.maxItems;
    return {
      id: item.sourceId,
      kind: item.kind,
      url: item.url,
      ...(maxItems === undefined ? {} : { maxItems }),
    };
  });
}

/** One fetcher per source kind, each serving the recorded items of the source it is asked for. */
export function recordedFetchers(items: readonly Item[]): DigestDeps['fetchers'] {
  return Object.fromEntries(
    SourceKindSchema.options.map((kind) => [
      kind,
      {
        kind,
        // Like the real fetchers: this source's newest items, at most `maxItems`.
        fetch: (source: Source, window: FetchWindow) =>
          Promise.resolve(
            newestFirst(items.filter((item) => item.sourceId === source.id)).slice(
              0,
              window.maxItems,
            ),
          ),
      },
    ]),
  );
}
