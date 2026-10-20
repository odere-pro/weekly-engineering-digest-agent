// How a Markdown renderer reads a link, as the link check needs it: a scanner for `](destination)`
// and the rule for where a bare url ends. Both read at least as much as a renderer does, so
// nothing can ride after a collected prefix, and both are single passes: a destination that does
// not parse is reported, and the scan resumes after what it read, so hostile text costs one scan.

/** At most this many unparsable destinations are reported: one is enough to reject the draft. */
export const MAX_MALFORMED_DESTINATIONS = 20;
/** A reported destination is a snippet: the model's text can be very long. */
const SNIPPET_CHARS = 60;
const SNIPPET_SOURCE_CHARS = SNIPPET_CHARS * 2;

/** JavaScript's `\s`: what `trim` removes. */
const isSpace = (char: string): boolean => char.trim() === '';

function skipSpaces(text: string, from: number): number {
  let at = from;
  while (at < text.length && isSpace(text[at] ?? '')) at += 1;
  return at;
}

/** What was read of one `](...)`: its destination and where the scan got to either way. */
type Read =
  | { readonly ok: true; readonly destination: string; readonly end: number }
  | { readonly ok: false; readonly end: number };

const failedAt = (end: number): { readonly ok: false; readonly end: number } => ({
  ok: false,
  end,
});

/** `<destination>`: no line break and no second `<` inside, as in CommonMark. */
function readAngleDestination(text: string, from: number): Read {
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === '>') return { ok: true, destination: text.slice(from, at), end: at + 1 };
    if (char === '<' || char === '\n' || char === '\r') return failedAt(at);
  }
  return failedAt(text.length);
}

/**
 * A destination without angle brackets runs to whitespace or to the `)` that closes the link;
 * parentheses inside it must balance, at any depth. One that does not, or that meets the end of
 * the text first, is not a destination.
 */
function readPlainDestination(text: string, from: number): Read {
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
    else if (char === ')' || isSpace(char)) {
      return depth === 0 ? { ok: true, destination: text.slice(from, at), end: at } : failedAt(at);
    }
  }
  return failedAt(text.length);
}

const TITLE_CLOSER: Readonly<Record<string, string>> = { '"': '"', "'": "'", '(': ')' };

/**
 * What follows a destination that ended at `from`: the `)` that closes the link, or a title
 * (after whitespace) and then that `)`. `end` is the index after the `)` when `ok`.
 */
function closingParen(text: string, from: number): { readonly ok: boolean; readonly end: number } {
  const at = skipSpaces(text, from);
  if (text[at] === ')') return { ok: true, end: at + 1 };
  const closer = at > from ? TITLE_CLOSER[text[at] ?? ''] : undefined;
  if (closer === undefined) return failedAt(at);
  const titleEnd = text.indexOf(closer, at + 1);
  if (titleEnd < 0) return failedAt(text.length);
  const after = skipSpaces(text, titleEnd + 1);
  return text[after] === ')' ? { ok: true, end: after + 1 } : failedAt(after);
}

/** The link that opens right after a `](` at `from`: destination, optional title, `)`. */
function readLink(text: string, from: number): Read {
  const start = skipSpaces(text, from);
  const read =
    text[start] === '<' ? readAngleDestination(text, start + 1) : readPlainDestination(text, start);
  if (!read.ok) return read;
  const closing = closingParen(text, read.end);
  // On success the scan resumes after the destination, so a title is read for links as well.
  return closing.ok ? read : failedAt(closing.end);
}

const snippet = (text: string, at: number): string => {
  const source = text.slice(at, at + SNIPPET_SOURCE_CHARS).replace(/\s+/g, ' ');
  return source.length > SNIPPET_CHARS ? `${source.slice(0, SNIPPET_CHARS - 3)}...` : source;
};

export interface LinkDestinations {
  /** Every destination that parsed, in order; `[x]()` gives an empty one. */
  readonly destinations: readonly string[];
  /** The start of each `](` that did not parse as a link (at most MAX_MALFORMED_DESTINATIONS). */
  readonly malformed: readonly string[];
}

/**
 * Every `](destination)` in `text`, read like CommonMark reads an inline link: the destination is
 * `<...>` or a run to whitespace with balanced parentheses, then an optional title in quotes or
 * parentheses, then `)`. Anything else after the destination is not a link, so it is reported
 * whole instead of guessed at. Text that a failed read passed over is not read again, which also
 * keeps the scan linear: the draft is rejected anyway.
 */
export function scanLinkDestinations(text: string): LinkDestinations {
  const destinations: string[] = [];
  const malformed: string[] = [];
  let at = text.indexOf('](');
  while (at >= 0 && malformed.length < MAX_MALFORMED_DESTINATIONS) {
    const read = readLink(text, at + 2);
    if (read.ok) destinations.push(read.destination);
    else malformed.push(snippet(text, at));
    at = text.indexOf('](', read.end);
  }
  return { destinations, malformed };
}

/**
 * A bare url as a renderer's autolinker reads it (GFM): `http(s)://` and everything up to
 * whitespace or `<`. The run also ends before `](`, where a `[https://x](https://x)` label stops
 * and its destination starts: that destination is read by `scanLinkDestinations`.
 */
const URL_RUN = /https?:\/\/(?:(?!\]\()[^\s<])+/gi;

/**
 * The shorter pieces of a url that earlier versions read, and that some renderers still cut a
 * link at: up to a bracket, a quote, a backtick or a parenthesis that does not pair up (one level
 * of `(...)` stays in). Read as well as the run, so a run does not hide what follows such a cut.
 */
const URL_PIECE = /https?:\/\/(?:[^\s<>"'`()[\]]|\([^\s()]*\))+/gi;

/** What an autolinker leaves out of a link when it ends the run: GFM's list, plus `;`. */
const TRAILING_PUNCTUATION = /^[?!.,:;*_~'"]$/;

/** Text that wraps a url and shows up after it: `<url>` and a code span around just the url. */
const WRAPPER_CLOSER: Readonly<Record<string, string>> = { '<': '>', '`': '`' };

/**
 * The url of a bare run: trailing punctuation is not part of it, nor is a `)` with no `(` in the
 * run to match, however often that repeats, nor the character that closes a wrapper the run
 * opened in (`closer`: the `>` of `<url>`). A balanced pair stays: `.../Foo_(bar)`. One pass.
 */
export function trimUrlRun(run: string, closer?: string): string {
  let open = 0;
  let close = 0;
  for (const char of run) {
    if (char === '(') open += 1;
    else if (char === ')') close += 1;
  }
  let end = run.length;
  while (end > 0) {
    const last = run[end - 1] ?? '';
    if (last === ')' && close > open) close -= 1;
    else if (!TRAILING_PUNCTUATION.test(last) && last !== closer) break;
    end -= 1;
  }
  return run.slice(0, end);
}

const closerBefore = (text: string, at: number): string | undefined =>
  WRAPPER_CLOSER[text[at - 1] ?? ''];

/**
 * Every bare http(s) url in `text`: each maximal run, and each piece of one. All of them must be
 * collected urls, so nothing can ride after a collected prefix, however a renderer cuts the run.
 */
export function bareUrls(text: string): string[] {
  const runs = Array.from(text.matchAll(URL_RUN), (match) =>
    trimUrlRun(match[0], closerBefore(text, match.index)),
  );
  const pieces = (text.match(URL_PIECE) ?? []).map((piece) => trimUrlRun(piece));
  return [...runs, ...pieces];
}

/**
 * `text` with each run that `isCut` replaced by a space (what was trimmed off its end stays).
 * The malformed-link search then looks at what is left, where a `www.` inside a collected url is
 * not a scheme-less link.
 */
export function withoutCollectedRuns(text: string, isCut: (url: string) => boolean): string {
  return text.replace(URL_RUN, (run: string, at: number) => {
    const url = trimUrlRun(run, closerBefore(text, at));
    return isCut(url) ? ` ${run.slice(url.length)}` : run;
  });
}

/** An opening tag as far as its attributes go: `<name` and what follows up to the next `<` or `>`. */
const OPEN_TAG = /<[a-z][^<>]*/gi;
/** `href` or `src` as an attribute: after whitespace, a quote or a slash, and followed by `=`. */
const URL_ATTRIBUTE = /[\s"'/](?:href|src)\s*=\s*["']?([^\s"'>]+)/gi;

/**
 * The value of every `href` and `src` attribute written in an HTML tag. In a query string
 * (`?src=rss`, `&href=x`) they are ordinary parameters, not attributes, so only text inside a
 * tag counts. A value is read to whitespace, a quote or `>`, as a browser reads it.
 */
export function htmlAttributeUrls(text: string): string[] {
  return Array.from(text.matchAll(OPEN_TAG), ([tag]) =>
    Array.from(tag.matchAll(URL_ATTRIBUTE), (match) => match[1] ?? ''),
  ).flat();
}
