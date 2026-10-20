// A collected link is written into the digest as `[title](url)`, read back by the link check and
// put into email and Slack markup. A character any of them takes for structure makes the link
// check find a shorter URL than the collected one, so every draft is rejected and the week ends
// blocked. The cure is at ingestion, where the link is built: the item carries a form with no such
// character, and the digest, the check and the channels all see the same text.

/**
 * What a Markdown destination, the link check's URL scan or a channel's markup ends or breaks
 * on: brackets, angle brackets, quotes, the backtick, the pipe (a table cell and a Slack link),
 * the backslash (Markdown's escape) and every character `visibleLine` turns into a space on the
 * way into the digest (whitespace, control and format characters, line and paragraph
 * separators, the tag block).
 */
// eslint-disable-next-line regexp/no-dupe-characters-character-class -- the tag block is listed whole on purpose: its unassigned code points are not Cf
const STRUCTURAL = /[()[\]<>'"`|\\\s\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/gu;
/** A feed that escaped its ampersand twice: the parsed link still holds the entity. */
const DOUBLE_ENCODED_AMPERSAND = /&amp;/gi;
/** An ampersand that starts a character reference, which the link check decodes. */
const REFERENCE_START = /&(?=(?:#x[0-9a-f]+|#\d+|[a-z]+);)/gi;
/** Ends a bare URL without being part of it: a reader (and GFM) takes these for the sentence. */
const SENTENCE_PUNCTUATION = '.,;:!*_~';
/** A query or fragment with nothing in it: the same page without it. */
const EMPTY_TAIL = '?#';
const UTF8 = new TextEncoder();

function percentEncode(character: string): string {
  return Array.from(
    UTF8.encode(character),
    (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('');
}

/** Where the trailing run of `characters` in `text` starts; scanned once, from the end. */
function trailingRunStart(text: string, characters: string): number {
  let start = text.length;
  while (start > 0 && characters.includes(text.charAt(start - 1))) start -= 1;
  return start;
}

/**
 * The link as the digest, the link check and the channels can all carry: no bracket, quote,
 * backtick, pipe, backslash, whitespace or invisible character, no character reference, and no
 * punctuation or empty query at the end. They are percent-encoded (a double-encoded `&amp;` is
 * the ampersand it stands for; an empty trailing `?` or `#` is dropped, which the item id never
 * saw). Anything else stays byte for byte: the item id is a hash of the link, and an ordinary link
 * keeps its id from week to week. It can be applied twice. The caller checks the result is still a
 * link: an IPv6 host in brackets is not.
 */
export function canonicalLink(link: string): string {
  const encoded = link
    .replace(DOUBLE_ENCODED_AMPERSAND, '&')
    .replace(STRUCTURAL, percentEncode)
    .replace(REFERENCE_START, '%26');
  const withoutTail = encoded.slice(0, trailingRunStart(encoded, EMPTY_TAIL));
  const punctuationAt = trailingRunStart(withoutTail, SENTENCE_PUNCTUATION);
  return `${withoutTail.slice(0, punctuationAt)}${Array.from(withoutTail.slice(punctuationAt), percentEncode).join('')}`;
}
