import type { Digest, Item } from '../schemas.js';
import { truncate } from '../../shared/text.js';
import { normalizeUrl } from '../../shared/url.js';
import type { CheckResult } from './types.js';

/** Bare http(s) URL; allows one level of balanced parentheses. */
const BARE_URL = /https?:\/\/(?:[^\s<>"'`()[\]]|\([^\s()]*\))+/gi;
/** Markdown link destination `](dest)`; allows one level of balanced parentheses. */
const MD_DESTINATION = /\]\(\s*<?((?:[^\s()<>]|\([^\s()]*\))*)>?[^)]*\)/g;
const HTML_DESTINATION = /\b(?:href|src)\s*=\s*["']?([^\s"'>]+)/gi;
/**
 * Forms that browsers or renderers resolve as links but that are not `scheme://`. The `www.` of
 * a full `http(s)://www.host` url is not one of them: BARE_URL reads that url whole and it must
 * be a collected one. Any other `www.` is, `ftp://www.host` and `https:/www.host` included.
 */
const MALFORMED_LINK = /(?:\bhttps?:(?!\/\/)|(?<!\bhttps?:\/\/)\bwww\.|(?<![:/\w])\/\/[^\s/])\S*/gi;
/** The lookbehind makes each run of punctuation one attempt; `/[.,;:!?]+$/` is quadratic on a long run. */
const TRAILING_PUNCTUATION = /(?<![.,;:!?])[.,;:!?]+$/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
};

const CHARACTER_REFERENCE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT_CHARACTER = '\uFFFD';
/** An invalid reference can be thousands of digits long; the problem only needs its start. */
const REPORTED_REFERENCE_CHARS = 24;

/** The code point a numeric reference names (`#x41`, `#65`); undefined for a named entity. */
function numericCodePoint(code: string): number | undefined {
  const lower = code.toLowerCase();
  if (lower.startsWith('#x')) return parseInt(lower.slice(2), 16);
  if (lower.startsWith('#')) return parseInt(lower.slice(1), 10);
  return undefined;
}

/** Past U+10FFFF (a digit run long enough to read as Infinity counts): fromCodePoint would throw. */
function isOutOfRange(codePoint: number): boolean {
  return !Number.isFinite(codePoint) || codePoint > MAX_CODE_POINT;
}

/** Numeric character references that name no Unicode code point; they make a draft unacceptable. */
function invalidReferences(text: string): string[] {
  return [...text.matchAll(CHARACTER_REFERENCE)].flatMap(([reference]) => {
    const codePoint = numericCodePoint(reference.slice(1, -1));
    return codePoint !== undefined && isOutOfRange(codePoint)
      ? [truncate(reference, REPORTED_REFERENCE_CHARS)]
      : [];
  });
}

/** Decodes entities and backslash escapes the way a Markdown renderer would. */
function decodeLikeMarkdown(text: string): string {
  return text
    .replace(CHARACTER_REFERENCE, (match, code: string) => {
      const codePoint = numericCodePoint(code);
      if (codePoint === undefined) return NAMED_ENTITIES[code.toLowerCase()] ?? match;
      return isOutOfRange(codePoint) ? REPLACEMENT_CHARACTER : String.fromCodePoint(codePoint);
    })
    .replace(/\\(.)/g, '$1');
}

function digestTexts(digest: Digest): string[] {
  return [
    digest.headline,
    digest.intro,
    ...digest.items.flatMap((i) => [i.title, i.area, i.summary, i.whyItMatters]),
  ];
}

function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] ?? '');
}

/**
 * Every URL-like thing in `text`; a non-empty `rejected` or `invalid` entry is never acceptable.
 * `invalid` lists numeric character references outside the Unicode range. A full url that is
 * collected is judged as a whole and left out of the malformed-link search: a `www.` in its host,
 * path or query is part of that url (W5-11).
 */
function linkCandidates(
  text: string,
  isKnown: (url: string) => boolean,
): {
  urls: string[];
  rejected: string[];
  invalid: string[];
} {
  const decoded = decodeLikeMarkdown(text);
  const destinations = [
    ...captures(decoded, MD_DESTINATION),
    ...captures(decoded, HTML_DESTINATION),
  ];
  const bare = (decoded.match(BARE_URL) ?? []).map((u) => u.replace(TRAILING_PUNCTUATION, ''));
  const outsideKnown = decoded.replace(BARE_URL, (url) =>
    isKnown(url.replace(TRAILING_PUNCTUATION, '')) ? ' ' : url,
  );
  const rejected = (outsideKnown.match(MALFORMED_LINK) ?? []).map((u) =>
    u.replace(TRAILING_PUNCTUATION, ''),
  );
  return { urls: [...destinations, ...bare], rejected, invalid: invalidReferences(text) };
}

/** Every URL in the digest (fields and rendered markdown) must exist in the collected items. Always on. */
export function linkCheck(digest: Digest, markdown: string, items: readonly Item[]): CheckResult {
  const known = new Set(items.map((item) => normalizeUrl(item.url)));
  const isKnown = (url: string): boolean => known.has(normalizeUrl(url));
  const problems = new Set<string>();

  // Item URLs must match as whole strings, so nothing can ride along after a known prefix.
  for (const item of digest.items) {
    if (!isKnown(item.url)) problems.add(`Unknown URL not in collected items: ${item.url}`);
  }
  for (const text of [...digestTexts(digest), markdown]) {
    const { urls, rejected, invalid } = linkCandidates(text, isKnown);
    for (const url of urls.filter((u) => !isKnown(u))) {
      problems.add(`Unknown URL not in collected items: ${url}`);
    }
    for (const url of rejected) problems.add(`Malformed or scheme-less link: ${url}`);
    for (const reference of invalid) problems.add(`Invalid character reference: ${reference}`);
  }
  return { ok: problems.size === 0, problems: [...problems] };
}
