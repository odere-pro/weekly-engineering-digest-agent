import type { DigestViewItem } from '../../../render/digestView';

const UNTITLED = '(untitled)';

// Whitespace, control characters and bidirectional overrides, so a model string stays on one
// line and cannot reorder the text around it. Other format characters (ZWJ emoji) stay.
const BLANK_RUN = /[\s\p{Cc}‪-‮⁦-⁩]+/gu;
const HAS_UNSAFE_CHAR = /[\s\p{Cc}\p{Cf}]/u;
const HTTP_SCHEME = /^https?:\/\//i;

/** One line: line breaks, tabs, control and bidi characters become single spaces. */
export function oneLine(text: string): string {
  return text.replaceAll(BLANK_RUN, ' ').trim();
}

/** A release title on one line, or a placeholder when nothing is left of it. */
export function titleOf(item: DigestViewItem): string {
  return oneLine(item.title) || UNTITLED;
}

/**
 * The URL in its normalised form when it is an absolute http(s) URL, otherwise undefined.
 * Whitespace, control and format characters, a scheme without `//` and credentials in the URL
 * (`https://github.com@evil.test/`) are all refused, so what is linked is what a reader sees.
 */
export function httpUrl(raw: string): string | undefined {
  if (HAS_UNSAFE_CHAR.test(raw) || !HTTP_SCHEME.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    const hasCredentials = url.username !== '' || url.password !== '';
    return hasCredentials ? undefined : url.href;
  } catch {
    return undefined;
  }
}

/** Escapes the five characters that matter in element text and in double- or single-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
