import type { Digest, Item } from '../domain/schemas';
import { truncate } from '../shared/text';
import { normalizeUrl } from '../shared/url';
import {
  bareUrls,
  htmlAttributeUrls,
  scanLinkDestinations,
  withoutCollectedRuns,
} from './linkSyntax';
import type { CheckResult } from './types';

/**
 * What each problem starts with; the quoted link or reference follows. The writer's retry prompt
 * (`write/writePrompt.ts`) matches on the first two to say what was wrong without showing the link,
 * so reword them here and the prompt follows.
 */
export const UNKNOWN_URL_PROBLEM = 'Unknown URL not in collected items: ';
export const MALFORMED_LINK_PROBLEM = 'Malformed or scheme-less link: ';
export const INVALID_REFERENCE_PROBLEM = 'Invalid character reference: ';

/** Trailing punctuation is trimmed from a text that is not a url (`www.host.`) one attempt per run. */
const TRAILING_PUNCTUATION = /(?<![.,;:!?])[.,;:!?]+$/;
/**
 * Forms that browsers or renderers resolve as links but that are not `scheme://`. The `www.` of
 * a full `http(s)://www.host` url is not one of them: it is read whole as a bare url and it
 * must be a collected one. Any other `www.` is, `ftp://www.host` and `https:/www.host` included.
 */
const MALFORMED_LINK = /(?:\bhttps?:(?!\/\/)|(?<!\bhttps?:\/\/)www\.|(?<![:/\w])\/\/[^\s/])\S*/gi;

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
    ...digest.items.flatMap((i) => [i.title, i.area, i.summary, i.whyItMatters, i.action ?? '']),
  ];
}

/**
 * Every URL-like thing in `text`; a non-empty `rejected` or `invalid` entry is never acceptable.
 * `invalid` lists numeric character references outside the Unicode range. A full url that is
 * collected, written as collected, is judged as a whole and left out of the malformed-link search:
 * a `www.` in its host, path or query is part of that url (W5-11). One that only matches after
 * normalizing is not left out: what normalizing drops (a fragment, `utm_*`) could hide a link.
 */
function linkCandidates(
  text: string,
  isCollected: (url: string) => boolean,
): {
  urls: string[];
  rejected: string[];
  invalid: string[];
} {
  const decoded = decodeLikeMarkdown(text);
  const { destinations, malformed } = scanLinkDestinations(decoded);
  const outsideKnown = withoutCollectedRuns(decoded, isCollected);
  const rejected = [
    ...(outsideKnown.match(MALFORMED_LINK) ?? []).map((u) => u.replace(TRAILING_PUNCTUATION, '')),
    ...malformed,
  ];
  return {
    urls: [...destinations, ...htmlAttributeUrls(decoded), ...bareUrls(decoded)],
    rejected,
    invalid: invalidReferences(text),
  };
}

/** A url that holds another url (`.../web/2020/https://x`), after its first character. */
const HOLDS_URL = /.https?:\/\//is;

/** Every URL in the digest (fields and rendered markdown) must exist in the collected items. Always on. */
export function linkCheck(digest: Digest, markdown: string, items: readonly Item[]): CheckResult {
  const written = new Set(items.map((item) => item.url.trim()));
  const known = new Set(items.map((item) => normalizeUrl(item.url)));
  const isCollected = (url: string): boolean => written.has(url);
  // Normalizing drops a fragment and tracking parameters, which can hold anything: a url that
  // holds another url is accepted only as collected, as a renderer may cut it in two.
  const isAccepted = (url: string): boolean =>
    known.has(normalizeUrl(url)) && (isCollected(url) || !HOLDS_URL.test(url));
  const problems = new Set<string>();

  // Item URLs must match as whole strings, so nothing can ride along after a known prefix.
  for (const item of digest.items) {
    if (!isAccepted(item.url)) problems.add(`${UNKNOWN_URL_PROBLEM}${item.url}`);
  }
  for (const text of [...digestTexts(digest), markdown]) {
    const { urls, rejected, invalid } = linkCandidates(text, isCollected);
    for (const url of urls.filter((u) => !isAccepted(u))) {
      problems.add(`${UNKNOWN_URL_PROBLEM}${url}`);
    }
    for (const url of rejected) problems.add(`${MALFORMED_LINK_PROBLEM}${url}`);
    for (const reference of invalid) problems.add(`${INVALID_REFERENCE_PROBLEM}${reference}`);
  }
  return { ok: problems.size === 0, problems: [...problems] };
}
