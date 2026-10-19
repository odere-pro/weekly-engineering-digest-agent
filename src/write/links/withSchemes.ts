import { normalizeUrl } from '../../shared/url';

/**
 * A link a browser or renderer would still follow, but without `https://`: `www.host/path` or
 * protocol-relative `//host/path`. It starts a match only at the start of the text or after
 * whitespace or an opening or emphasis character, so the `//` or `www.` inside `https://www.host`,
 * or in the path or query of any url (`?u=//host`), never does.
 */
const SCHEME_LESS_LINK = /(?<=^|[\s([{<>"'*_~])(?:www\.|\/\/(?=[^\s/]))[^\s<>"'`\]]+/gi;
/** What can end a sentence or close a Markdown link without being part of the url. */
const LINK_TRAILING = /[)\]}.,;:!?*_~]$/;
/** A collected url is far shorter; a longer token is not worth a lookup. */
export const MAX_LINK_CHARS = 2048;
/** Closing characters tried off the end of a token, so the work per token is bounded. */
export const MAX_TRAILING_CHARS = 8;

/** The collected urls as written, keyed by the form the link check compares them in. */
export function indexCollectedUrls(collectedUrls: readonly string[]): ReadonlyMap<string, string> {
  return new Map(collectedUrls.map((url) => [normalizeUrl(url), url]));
}

/**
 * Adds the scheme to each scheme-less link in `text` that is, once `https://` is in front and
 * both sides are normalised the way the link check does, exactly a collected url. The collected
 * url as written replaces it, so the draft can only gain urls the link check accepts. Any other
 * link stays as it is, and the link check rejects it. `onRepair` is called once per link fixed.
 */
export function withSchemes(
  text: string,
  known: ReadonlyMap<string, string>,
  onRepair: () => void,
): string {
  if (known.size === 0) return text;
  return text.replace(SCHEME_LESS_LINK, (token) => {
    const fixed = collectedUrlFor(token, known);
    if (fixed !== token) onRepair();
    return fixed;
  });
}

/** The collected url the token names, followed by what was trimmed off its end; else the token. */
export function collectedUrlFor(token: string, known: ReadonlyMap<string, string>): string {
  if (token.length > MAX_LINK_CHARS) return token;
  let end = token.length;
  for (let trimmed = 0; trimmed <= MAX_TRAILING_CHARS; trimmed += 1) {
    const link = token.slice(0, end);
    const url = known.get(
      normalizeUrl(link.startsWith('//') ? `https:${link}` : `https://${link}`),
    );
    if (url !== undefined) return url + token.slice(end);
    if (!LINK_TRAILING.test(link)) break;
    end -= 1;
  }
  return token;
}
