import type { Item, Source } from '../../../domain/schemas';
import { toPlainText, truncate } from '../../../shared/text';
import { itemIdFor } from '../../../shared/url';
import { parseFeedDate } from '../feedFields';
import { canonicalLink } from './canonicalLink';
import type { RawEntry } from './types';

/** Query parameter that tells apart entries of one feed that share a link. */
const ENTRY_PARAM = 'entry';
/**
 * A title and a link reach every model prompt in full, so a feed cannot be allowed to pad them:
 * a guard that trims an over-long state keeps the head and a short tail, and padding hides an
 * instruction from it while the writer still reads it. Real titles are far shorter than this and
 * real links shorter than what browsers and servers accept.
 */
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 2_048;

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
 * The link the item keeps, or undefined when the entry has none worth keeping: not http(s), too
 * long, or no link once made safe for the digest markup (see `canonicalLink`). The entry id is
 * canonicalized with the rest: `encodeURIComponent` leaves brackets, apostrophes and full stops.
 */
function itemLink(entry: RawEntry, options: NormalizeOptions): string | undefined {
  const link = entry.url.trim();
  if (!link || !isHttpUrl(link)) return undefined;
  const entryId = options.distinctLink ? entry.entryId : undefined;
  const url = canonicalLink(entryId === undefined ? link : withEntryId(link, entryId));
  return url.length <= MAX_URL_CHARS && isHttpUrl(url) ? url : undefined;
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
  const url = itemLink(entry, options);
  const published = toDate(entry.publishedAt);
  if (!url || !published) return undefined;

  return {
    id: itemIdFor(url),
    sourceId: source.id,
    kind: source.kind,
    url,
    title: truncate(entry.title.trim(), MAX_TITLE_CHARS),
    summary: truncate(toPlainText(entry.text), options.maxSummaryChars),
    publishedAt: published.toISOString(),
  };
}
