/** A token that holds one of these could become a link; a url in a source's text is dropped. */
const LINK_LIKE = /:\/\/|\b(?:https?|ftp|mailto|javascript):|\bwww\.|\/\/|\]\(|&#/i;
/** A character reference: the link check decodes it, so a token with one is dropped. */
const REFERENCE = /&[#a-z0-9]+;/i;

/** The longest source title the digest uses as its own text: it is link text, on one line. */
export const SOURCE_TITLE_MAX_CHARS = 120;

/**
 * Text a feed wrote, as safe digest text: one line of single spaces, without any token the link
 * check could read as a link or a character reference (`://`, `//`, `www.`, `](`, `&#`, `&amp;`,
 * a scheme such as `http:` or `mailto:`). The fallback digest and the title repair both clean
 * source text with it, so the two cannot drift. Pure; the text is feed content and the work is
 * linear: a split, then one test per token.
 */
export function safeSourceText(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => token !== '' && !LINK_LIKE.test(token) && !REFERENCE.test(token))
    .join(' ');
}
