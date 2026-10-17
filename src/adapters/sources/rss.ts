import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import type { Item, Source } from '../../core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../../ports/SourceFetcher.js';
import { errorMessage } from '../../shared/errors.js';
import { noopLogger, type Logger } from '../../shared/telemetry.js';
import { toPlainText, truncate } from '../../shared/text.js';
import { itemIdFor } from '../../shared/url.js';
import { choicesOf, parseFeedDate, rawChoices } from './feedFields.js';
import { getText, permanentFailure, sameSiteAs, statusFailure } from './http.js';

const DEFAULT_MAX_SUMMARY_CHARS = 600;
/** Query parameter that tells apart entries of one feed that share a link. */
const ENTRY_PARAM = 'entry';
/** A feed-controlled error text reaches the log only up to this length. */
const MAX_LOGGED_ERROR_CHARS = 300;

export interface RssFetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Summary length cap in characters. */
  maxSummaryChars?: number;
  /** Where an entry that had to be skipped is reported. */
  logger?: Logger;
}

/** An entry turned into an item, with the feed's own id for it. */
interface Candidate {
  item: Item;
  entryId: string;
}

function parseEntries(xml: string, sourceId: string): FeedEntry[] {
  try {
    return (
      extractFromXml(xml, {
        // 0 turns off the library's own 250-char cut; we truncate ourselves.
        descriptionMaxLen: 0,
        // Keep the feed's own date text: the library would read a zone-less date in local time.
        useISODateFormat: false,
        getExtraEntryFields: (raw) => ({ ...rawChoices(raw) }),
      }).entries ?? []
    );
  } catch (error) {
    throw permanentFailure(`Cannot parse feed ${sourceId}: ${errorMessage(error)}`, error);
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

/** The first date text that parses, best first. */
function firstDate(texts: readonly (string | undefined)[]): Date | undefined {
  for (const text of texts) {
    const date = text === undefined ? undefined : parseFeedDate(text);
    if (date) return date;
  }
  return undefined;
}

/** One feed entry to a candidate, or undefined when it has no usable http(s) link or date. */
function toCandidate(
  entry: FeedEntry,
  source: Source,
  maxSummaryChars: number,
): Candidate | undefined {
  const choices = choicesOf(entry);
  const url = (choices.alternateUrl ?? entry.link)?.trim();
  const published = firstDate([...(choices.dateTexts ?? []), entry.published]);
  if (!url || !isHttpUrl(url) || !published) return undefined;

  const html = choices.html ?? entry.description ?? '';
  return {
    entryId: entry.id,
    item: {
      id: itemIdFor(url),
      sourceId: source.id,
      kind: 'rss',
      url,
      title: entry.title?.trim() ?? '',
      summary: truncate(toPlainText(html), maxSummaryChars),
      publishedAt: published.toISOString(),
    },
  };
}

/** What reading a feed's entries produced: the usable ones, and the reasons the others threw. */
interface EntryReading {
  candidates: Candidate[];
  failures: string[];
}

/** A single bad entry is set aside; it never fails the whole source. */
function readEntries(
  entries: readonly FeedEntry[],
  source: Source,
  maxSummaryChars: number,
): EntryReading {
  const candidates: Candidate[] = [];
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      const candidate = toCandidate(entry, source, maxSummaryChars);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  return { candidates, failures };
}

/**
 * One line per feed, not per entry: entries that threw, or a feed whose entries all lack a
 * usable link or date (a changed date format would otherwise empty the feed without a trace).
 */
function reportUnusable(
  logger: Logger,
  source: Source,
  entryCount: number,
  { candidates, failures }: EntryReading,
): void {
  if (failures.length > 0) {
    logger.warn('Skipped feed entries that could not be read', {
      sourceId: source.id,
      failed: failures.length,
      of: entryCount,
      firstError: truncate(failures[0] ?? '', MAX_LOGGED_ERROR_CHARS),
    });
  } else if (entryCount > 0 && candidates.length === 0) {
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
 * to week while the feed keeps repeating that link. A query parameter, not a fragment:
 * normalized URLs drop fragments.
 */
function withDistinctLinks(candidates: readonly Candidate[]): Item[] {
  const uses = new Map<string, number>();
  for (const { item } of candidates) uses.set(item.id, (uses.get(item.id) ?? 0) + 1);
  return candidates.map(({ item, entryId }) =>
    (uses.get(item.id) ?? 0) > 1 ? withEntryId(item, entryId) : item,
  );
}

/** Appends to the query as it stands, so the link's own parameters keep their bytes. */
function withEntryId(item: Item, entryId: string): Item {
  const url = new URL(item.url);
  const param = `${ENTRY_PARAM}=${encodeURIComponent(entryId)}`;
  url.search = url.search ? `${url.search}&${param}` : `?${param}`;
  return { ...item, id: itemIdFor(url.href), url: url.href };
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
  const logger = options.logger ?? noopLogger;

  return {
    kind: 'rss',
    async fetch(source, window, signal) {
      const reply = await getText(source.url, {
        fetch: request,
        label: source.id,
        signal,
        allowsRedirectTo: sameSiteAs(source.url),
      });
      if (!reply.ok) throw statusFailure(reply.status, source.id);

      const entries = parseEntries(reply.body, source.id);
      const reading = readEntries(entries, source, maxSummaryChars);
      reportUnusable(logger, source, entries.length, reading);
      return withDistinctLinks(reading.candidates)
        .filter((item) => isInWindow(item, window))
        .sort(newestFirst)
        .slice(0, window.maxItems);
    },
  };
}
