const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const MAX_CODE_POINT = 0x10ffff;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_END = 0xdfff;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

/** The character for a numeric entity, or the entity text itself when it names no character. */
function decodeCodePoint(digits: string, radix: number, entity: string): string {
  const codePoint = Number.parseInt(digits, radix);
  const isSurrogate = codePoint >= HIGH_SURROGATE_START && codePoint <= LOW_SURROGATE_END;
  return codePoint > MAX_CODE_POINT || isSurrogate ? entity : String.fromCodePoint(codePoint);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X'))
      return decodeCodePoint(code.slice(2), HEX_RADIX, match);
    if (code.startsWith('#')) return decodeCodePoint(code.slice(1), DECIMAL_RADIX, match);
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Where the block that opens at `openAt` ends, just after its closing tag; -1 when it never
 * closes. The `>` of the opening tag and the closing tag are each searched for once, forward,
 * so a long run of openers costs one scan, not one per opener.
 */
function blockEnd(html: string, openAt: number, close: RegExp): number {
  const openingTagEnd = html.indexOf('>', openAt);
  if (openingTagEnd < 0) return -1;
  close.lastIndex = openingTagEnd + 1;
  const closing = close.exec(html);
  return closing ? closing.index + closing[0].length : -1;
}

/**
 * Replaces each `<script>` and `<style>` block, text included, with a space. Whatever follows a
 * block that never closes is dropped, as a browser does: it is script or style text, not prose.
 * One pass, so hostile input (the worst case is a long run of unclosed openers) stays linear;
 * a lazy `[\s\S]*?` regex would rescan to the end of the text for every opener.
 */
function withoutBlocks(html: string): string {
  const open = /<(script|style)(?=[\s/>])/gi;
  const closeScript = /<\/script>/gi;
  const closeStyle = /<\/style>/gi;
  const kept: string[] = [];
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const opener = open.exec(html);
    if (!opener) return [...kept, html.slice(from)].join('');
    kept.push(html.slice(from, opener.index), ' ');
    const [, name = ''] = opener;
    const end = blockEnd(
      html,
      opener.index,
      name.toLowerCase() === 'script' ? closeScript : closeStyle,
    );
    if (end < 0) return kept.join('');
    from = end;
  }
}

/**
 * A tag: "<", then anything but a bracket, then ">". Excluding "<" from the body means a failed
 * attempt never reads past the next "<", so no character is scanned twice.
 */
const TAG = /<[^<>]+>/g;

/** HTML or Markdown-ish feed content to one line of plain text. */
export function toPlainText(html: string): string {
  const withoutTags = withoutBlocks(html).replace(TAG, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/**
 * Control characters, format characters, the line and paragraph separators, and the whole tag
 * block. The classes, not a hand-listed set of ranges: Unicode keeps adding invisible format
 * characters (bidi controls, joiners, the byte order mark, soft hyphen), and a list written today
 * misses them. The tag block is listed too because its unassigned code points (U+E0000,
 * U+E0002-E001F) are not `Cf`. Private to the module: a shared `/g` regex keeps `lastIndex` state.
 */
// eslint-disable-next-line regexp/no-dupe-characters-character-class -- the tag block is listed whole on purpose: its unassigned code points are not Cf
const UNPRINTABLE_RUN = /[\p{Cc}\p{Cf}\u2028\u2029\u{E0000}-\u{E007F}]+/gu;

/**
 * Text a model or a feed wrote, as one line safe to print in a terminal: every run of control
 * (escapes, newlines, C1), format (zero-width, bidi, tag) and line or paragraph separator
 * characters becomes one space, and the ends are trimmed. A zero-width joiner counts, so a joined
 * emoji prints as its parts.
 */
export function printableLine(text: string): string {
  return text.replace(UNPRINTABLE_RUN, ' ').trim();
}

/** Drops a final high surrogate, whose low half a cut has removed. */
function withoutSplitSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= HIGH_SURROGATE_START && last <= HIGH_SURROGATE_END ? text.slice(0, -1) : text;
}

/**
 * Cuts `text` to at most `maxChars`, at a word boundary, adding "..." when cut.
 * Never splits a surrogate pair.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = withoutSplitSurrogate(text.slice(0, Math.max(0, maxChars - 3)));
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
