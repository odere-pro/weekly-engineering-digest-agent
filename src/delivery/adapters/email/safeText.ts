import type { DigestViewItem } from '../../../render/digestView';
import { visibleLine } from '../../../render/visibleLine';

const UNTITLED = '(untitled)';

const HAS_UNSAFE_CHAR = /[\s\p{Cc}\p{Cf}]/u;
const HTTP_SCHEME = /^https?:\/\//i;

/**
 * One line a reader sees as written: line breaks, tabs, control characters and invisible format
 * characters (bidi, zero-width, tag) become single spaces, so a model string stays on one line
 * and cannot reorder or hide the text around it. A joiner between emoji stays, as in Slack.
 */
export function oneLine(text: string): string {
  return visibleLine(text);
}

/** A release title on one line, or a placeholder when nothing is left of it. */
export function titleOf(item: Pick<DigestViewItem, 'title'>): string {
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
