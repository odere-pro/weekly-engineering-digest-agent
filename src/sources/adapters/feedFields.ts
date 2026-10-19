import type { FeedEntry } from '@extractus/feed-extractor';

// The feed library flattens each entry before we see it: it takes the first <link> whatever its
// rel, lets `updated` beat `published`, reads a zone-less date in local time, and strips tags in
// a way that keeps <script> text and loses `Vec<T>`. These helpers read the raw entry instead,
// through the library's `getExtraEntryFields` hook, and are the only place that knows its shape.

/** An entry as the XML parser produced it: attributes are keys that start with "@_". */
export type XmlEntry = Readonly<Record<string, unknown>>;

/** What `rawChoices` adds to an entry; `choicesOf` reads it back. */
export interface RawChoices {
  alternateUrl: string | undefined;
  /** Date texts, best first: published before updated. */
  dateTexts: string[];
  /** Description or content as markup, not yet turned into plain text. */
  html: string;
}

/** Entry fields in order of preference: published first, the Atom 0.3 names last. */
const DATE_KEYS = ['published', 'pubDate', 'dc:date', 'issued', 'updated', 'modified'] as const;
/** The fullest text first: the full body, then the short text. */
const HTML_KEYS = ['content:encoded', 'content', 'summary', 'description'] as const;

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SLASH_DATE_ONLY = /^\d{4}\/\d{2}\/\d{2}$/;
const ISO_DATE_TIME_NO_ZONE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
/**
 * A date that ends in a clock time (12 or 24 hour) or a year has no zone after it; a signed
 * offset is a zone.
 */
const ENDS_WITHOUT_ZONE =
  /(?:(?<![+\-\d:])\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AP]M)?|(?<![+\-\d])\d{4})$/i;

const TRACKING_PREFIX = 'utm_';
/** Common click-tracking parameters; a link is shown to readers without them. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  '_hsenc',
  '_openstat',
]);

/** Feed text is either a string or `{ '#text': string }` when the node has attributes. */
export function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return typeof node['#text'] === 'string' ? node['#text'] : '';
  }
  return '';
}

/**
 * An absolute http(s) URL without tracking parameters or a fragment, which is how the feed
 * library hands out the links it picks itself. Undefined for anything else.
 */
export function cleanLink(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  // Deleting re-encodes the whole query, so a query with nothing to remove is left alone.
  for (const name of [...url.searchParams.keys()].filter(isTrackingParam)) {
    url.searchParams.delete(name);
  }
  url.hash = '';
  return url.href;
}

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(TRACKING_PREFIX) || TRACKING_PARAMS.has(lower);
}

/**
 * The cleaned href of the entry's `rel="alternate"` link (a link without rel is one, per
 * RFC 4287). Undefined when the links are plain text, as in RSS, or none is a usable alternate:
 * the library's own pick stands then.
 */
export function alternateLink(raw: XmlEntry): string | undefined {
  const links: unknown[] = Array.isArray(raw.link) ? raw.link : [raw.link];
  for (const link of links) {
    if (typeof link !== 'object' || link === null) continue;
    const rel = '@_rel' in link ? link['@_rel'] : undefined;
    const href = '@_href' in link ? link['@_href'] : undefined;
    const cleaned = typeof href === 'string' ? cleanLink(href) : undefined;
    if ((rel === undefined || rel === 'alternate') && cleaned) return cleaned;
  }
  return undefined;
}

/** The entry's date texts that are not blank, published before updated. */
export function dateTexts(raw: XmlEntry): string[] {
  return DATE_KEYS.map((key) => textOf(raw[key]).trim()).filter((text) => text !== '');
}

/**
 * Typographic named entities that `toPlainText` leaves as they are. Full bodies (unlike the
 * short excerpts) use them freely, and none of them can open or close a tag.
 */
const TYPOGRAPHIC_ENTITIES: Readonly<Record<string, string>> = {
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  sbquo: '\u201a',
  bdquo: '\u201e',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  middot: '\u00b7',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  times: '\u00d7',
  rarr: '\u2192',
  larr: '\u2190',
};

const NAMED_ENTITY = /&([a-z]+);/gi;

function withTypographicEntities(html: string): string {
  return html.replace(NAMED_ENTITY, (match, name: string) => TYPOGRAPHIC_ENTITIES[name] ?? match);
}

/** The entry's description or content, still as markup. */
export function entryHtml(raw: XmlEntry): string {
  for (const key of HTML_KEYS) {
    const text = textOf(raw[key]);
    if (text) return withTypographicEntities(text);
  }
  return '';
}

/** For the library's `getExtraEntryFields`. */
export function rawChoices(raw: XmlEntry): RawChoices {
  return { alternateUrl: alternateLink(raw), dateTexts: dateTexts(raw), html: entryHtml(raw) };
}

/** Reads back what `rawChoices` added; a field the entry does not carry is left out. */
export function choicesOf(entry: FeedEntry): Partial<RawChoices> {
  const { alternateUrl, dateTexts: dates, html } = entry;
  return {
    ...(typeof alternateUrl === 'string' ? { alternateUrl } : {}),
    ...(Array.isArray(dates)
      ? { dateTexts: dates.filter((text): text is string => typeof text === 'string') }
      : {}),
    ...(typeof html === 'string' ? { html } : {}),
  };
}

/**
 * Parses a feed date. A date with a time but no zone is read as UTC (JavaScript would read it
 * in the machine's zone, so the digest would change with where it runs).
 */
export function parseFeedDate(text: string): Date | undefined {
  const date = new Date(withUtcZone(text.trim()));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function withUtcZone(text: string): string {
  if (ISO_DATE_ONLY.test(text)) return text;
  const iso = ISO_DATE_TIME_NO_ZONE.exec(text);
  if (iso) return `${iso[1] ?? ''}T${iso[2] ?? ''}Z`;
  return SLASH_DATE_ONLY.test(text) || ENDS_WITHOUT_ZONE.test(text) ? `${text} GMT` : text;
}
