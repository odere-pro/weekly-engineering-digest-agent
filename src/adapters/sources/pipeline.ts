import type { Item, Source, SourceKind } from '../../core/schemas.js';
import { ItemSchema } from '../../core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../../ports/SourceFetcher.js';
import { errorMessage } from '../../shared/errors.js';
import { noopLogger, type Logger } from '../../shared/telemetry.js';
import { toPlainText, truncate } from '../../shared/text.js';
import { itemIdFor } from '../../shared/url.js';
import { enrichEntries } from './enrich.js';
import { parseFeedDate } from './feedFields.js';
import { getText, sameSiteAs, type Reply } from './http.js';

// The shared path of every source: an adapter requests its vendor's response and parses it into
// raw entries; everything after that is the same for all of them (normalize, validate, window,
// sort, cap, and the article-page enrichment of entries that came without text).

const DEFAULT_MAX_SUMMARY_CHARS = 600;
/** Query parameter that tells apart entries of one feed that share a link. */
const ENTRY_PARAM = 'entry';
/** A feed-controlled error text reaches the log only up to this length. */
const MAX_LOGGED_ERROR_CHARS = 300;

/** What an adapter found in one entry of its vendor's response; nothing is normalized yet. */
export interface RawEntry {
  url: string;
  title: string;
  /** The richest body the response carries, HTML or Markdown allowed, not truncated; empty if none. */
  text: string;
  /** A date text is read like a feed date: a time without a zone is UTC. */
  publishedAt: string | Date;
  /** The feed's own id for the entry; tells apart entries that share a link. */
  entryId?: string;
}

export interface GetInit {
  headers?: Record<string, string> | undefined;
  maxBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** One GET through `http.ts`: same-site redirects only, body capped, errors name the source. */
export type Get = (url: string, init?: GetInit) => Promise<Reply>;

export interface SourceAdapter {
  readonly kind: SourceKind;
  /** Hosts besides the source's own that a redirect may reach (an API host). */
  readonly redirectHosts?: readonly string[];
  /** False when a page would add nothing the response lacks. Default true. */
  readonly enrichable?: boolean;
  request(source: Source, window: FetchWindow, get: Get): Promise<Reply[]>;
  /** Throws a `FetchError` when the whole response is unusable. */
  parse(reply: Reply, source: Source): RawEntry[];
}

export interface NormalizeOptions {
  maxSummaryChars: number;
  /** Append the entry id to the link, for a feed whose entries share one. */
  distinctLink?: boolean;
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

function toDate(value: string | Date): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  return parseFeedDate(value);
}

/** Appends to the query as it stands, so the link's own parameters keep their bytes. */
function withEntryId(link: string, entryId: string): string {
  const url = new URL(link);
  const param = `${ENTRY_PARAM}=${encodeURIComponent(entryId)}`;
  url.search = url.search ? `${url.search}&${param}` : `?${param}`;
  return url.href;
}

/**
 * The only place an `Item` is built. Undefined for an entry without a usable http(s) link or
 * date. May throw on a value the text helpers cannot handle; the caller skips that entry.
 */
export function normalizeEntry(
  entry: RawEntry,
  source: Source,
  options: NormalizeOptions,
): Item | undefined {
  const link = entry.url.trim();
  const published = toDate(entry.publishedAt);
  if (!link || !isHttpUrl(link) || !published) return undefined;

  const url =
    options.distinctLink && entry.entryId !== undefined ? withEntryId(link, entry.entryId) : link;
  return {
    id: itemIdFor(url),
    sourceId: source.id,
    kind: source.kind,
    url,
    title: entry.title.trim(),
    summary: truncate(toPlainText(entry.text), options.maxSummaryChars),
    publishedAt: published.toISOString(),
  };
}

export interface FetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Summary length cap in characters. */
  maxSummaryChars?: number;
  /** Where an entry that had to be skipped is reported. */
  logger?: Logger;
  /** Fetch the entry page when the response carries no text. Default true. */
  enrich?: boolean;
}

/** A raw entry with the item it became. */
interface Pair {
  entry: RawEntry;
  item: Item;
}

interface Reading {
  pairs: Pair[];
  failures: string[];
}

function readEntries(entries: readonly RawEntry[], source: Source, maxChars: number): Reading {
  const pairs: Pair[] = [];
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      const item = normalizeEntry(entry, source, { maxSummaryChars: maxChars });
      if (item && ItemSchema.safeParse(item).success) pairs.push({ entry, item });
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  return { pairs, failures };
}

/**
 * One line per feed, not per entry: entries that threw, or a feed whose entries all lack a
 * usable link or date (a changed date format would otherwise empty the feed without a trace).
 */
function reportUnusable(
  logger: Logger,
  source: Source,
  entryCount: number,
  { pairs, failures }: Reading,
): void {
  if (failures.length > 0) {
    logger.warn('Skipped feed entries that could not be read', {
      sourceId: source.id,
      failed: failures.length,
      of: entryCount,
      firstError: truncate(failures[0] ?? '', MAX_LOGGED_ERROR_CHARS),
    });
  } else if (entryCount > 0 && pairs.length === 0) {
    logger.warn('No feed entry had a usable link and date', {
      sourceId: source.id,
      entries: entryCount,
    });
  }
}

/**
 * Some feeds (Google Cloud release notes) give every entry the same link, which would make
 * them one item. Entries that share a link, as dedupe sees it, get the feed's own entry id as a
 * query parameter. The whole feed decides, not the window, so an entry keeps its URL from week
 * to week while the feed keeps repeating that link.
 */
function withDistinctLinks(pairs: readonly Pair[], source: Source, maxChars: number): Pair[] {
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

/** The enriched text goes through the same normalization as feed text. */
function refreshed(
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

/** Wraps an adapter into the `SourceFetcher` port. */
export function createFetcher(adapter: SourceAdapter, options: FetcherOptions = {}): SourceFetcher {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const logger = options.logger ?? noopLogger;
  const shouldEnrich = (options.enrich ?? true) && adapter.enrichable !== false;

  return {
    kind: adapter.kind,
    async fetch(source, window, signal) {
      const allowsRedirectTo = sameSiteAs(source.url, ...(adapter.redirectHosts ?? []));
      const get: Get = (url, init = {}) =>
        getText(url, {
          fetch: fetchImpl,
          label: source.id,
          allowsRedirectTo,
          headers: init.headers,
          maxBytes: init.maxBytes,
          signal: init.signal ?? signal,
        });

      const replies = await adapter.request(source, window, get);
      const entries = replies.flatMap((reply) => adapter.parse(reply, source));
      const reading = readEntries(entries, source, maxChars);
      reportUnusable(logger, source, entries.length, reading);

      const selected = withDistinctLinks(reading.pairs, source, maxChars)
        .filter((pair) => isInWindow(pair, window))
        .sort(newestFirst)
        .slice(0, window.maxItems);
      if (!shouldEnrich) return selected.map(({ item }) => item);

      const enriched = await enrichEntries(
        selected.map(({ entry }) => entry),
        source,
        { get, logger, signal },
      );
      return refreshed(enriched, selected, source, maxChars);
    },
  };
}
