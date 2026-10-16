import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import type { Item, Source } from '../../core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../../ports/SourceFetcher.js';
import { toPlainText, truncate } from '../../shared/text.js';
import { itemIdFor } from '../../shared/url.js';

const DEFAULT_MAX_SUMMARY_CHARS = 600;

export interface RssFetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Summary length cap in characters. */
  maxSummaryChars?: number;
}

function parseEntries(xml: string, sourceId: string): FeedEntry[] {
  try {
    // descriptionMaxLen 0 turns off the library's own 250-char cut; we truncate ourselves.
    return extractFromXml(xml, { descriptionMaxLen: 0 }).entries ?? [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse feed ${sourceId}: ${reason}`, { cause: error });
  }
}

/** Only http(s) links may enter the collected set; the link check trusts what is collected. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** One feed entry to an Item, or undefined when it has no usable http(s) link or date. */
function toItem(entry: FeedEntry, source: Source, maxSummaryChars: number): Item | undefined {
  const url = entry.link?.trim();
  const publishedMs = Date.parse(entry.published ?? '');
  if (!url || !isHttpUrl(url) || Number.isNaN(publishedMs)) return undefined;

  return {
    id: itemIdFor(url),
    sourceId: source.id,
    kind: 'rss',
    url,
    title: entry.title?.trim() ?? '',
    summary: truncate(toPlainText(entry.description ?? ''), maxSummaryChars),
    publishedAt: new Date(publishedMs).toISOString(),
  };
}

function isInWindow(item: Item, window: FetchWindow): boolean {
  const publishedMs = Date.parse(item.publishedAt);
  return publishedMs >= window.since.getTime() && publishedMs <= window.until.getTime();
}

function newestFirst(a: Item, b: Item): number {
  return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
}

/** RSS and Atom feeds (W1-01). */
export function createRssFetcher(options: RssFetcherOptions = {}): SourceFetcher {
  const request: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;

  return {
    kind: 'rss',
    async fetch(source, window, signal) {
      const response = await request(source.url, { signal: signal ?? null });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${source.id}`);

      return parseEntries(await response.text(), source.id)
        .map((entry) => toItem(entry, source, maxSummaryChars))
        .filter((item): item is Item => item !== undefined && isInWindow(item, window))
        .sort(newestFirst)
        .slice(0, window.maxItems);
    },
  };
}
