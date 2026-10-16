import type { Digest, Item } from '../schemas.js';
import { normalizeUrl } from '../../shared/url.js';
import type { CheckResult } from './types.js';

/** Bare http(s) URL; allows one level of balanced parentheses. */
const BARE_URL = /https?:\/\/(?:[^\s<>"'`()[\]]|\([^\s()]*\))+/gi;
/** Markdown link destination `](dest)`; allows one level of balanced parentheses. */
const MD_DESTINATION = /\]\(\s*<?((?:[^\s()<>]|\([^\s()]*\))*)>?[^)]*\)/g;
const HTML_DESTINATION = /\b(?:href|src)\s*=\s*["']?([^\s"'>]+)/gi;
/** Forms that browsers or renderers resolve as links but that are not `scheme://`. */
const MALFORMED_LINK = /(?:\bhttps?:(?!\/\/)|\bwww\.|(?<![:/\w])\/\/[^\s/])\S*/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
};

/** Decodes entities and backslash escapes the way a Markdown renderer would. */
function decodeLikeMarkdown(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return NAMED_ENTITIES[lower] ?? match;
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

/** Every URL-like thing in `text`; a non-empty `rejected` entry is never acceptable. */
function linkCandidates(text: string): { urls: string[]; rejected: string[] } {
  const decoded = decodeLikeMarkdown(text);
  const destinations = [
    ...captures(decoded, MD_DESTINATION),
    ...captures(decoded, HTML_DESTINATION),
  ];
  const bare = (decoded.match(BARE_URL) ?? []).map((u) => u.replace(TRAILING_PUNCTUATION, ''));
  const rejected = (decoded.match(MALFORMED_LINK) ?? []).map((u) =>
    u.replace(TRAILING_PUNCTUATION, ''),
  );
  return { urls: [...destinations, ...bare], rejected };
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
    const { urls, rejected } = linkCandidates(text);
    for (const url of urls.filter((u) => !isKnown(u))) {
      problems.add(`Unknown URL not in collected items: ${url}`);
    }
    for (const url of rejected) problems.add(`Malformed or scheme-less link: ${url}`);
  }
  return { ok: problems.size === 0, problems: [...problems] };
}
