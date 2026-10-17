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

/** HTML or Markdown-ish feed content to one line of plain text. */
export function toPlainText(html: string): string {
  const withoutBlocks = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
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
