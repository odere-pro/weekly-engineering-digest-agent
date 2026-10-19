import type { Item, Source } from '../../../domain/schemas';
import { toPlainText, truncate } from '../../../shared/text';
import { itemIdFor } from '../../../shared/url';
import { parseFeedDate } from '../feedFields';
import type { RawEntry } from './types';

/** Query parameter that tells apart entries of one feed that share a link. */
const ENTRY_PARAM = 'entry';

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
