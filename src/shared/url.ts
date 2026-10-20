import { createHash } from 'node:crypto';

const TRACKING_PARAMS = new Set(['ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'source']);

/**
 * Canonical form used for item ids, dedupe and the link check: lowercase host, no default
 * port, no fragment, no tracking params, sorted query, no trailing slash (except the root).
 * Returns the input unchanged when it is not an http(s) URL.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw.trim();
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  const params = [...url.searchParams.entries()]
    .filter(
      ([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(key.toLowerCase()),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(params).toString();
  if (url.pathname.length > 1 && url.pathname.endsWith('/'))
    url.pathname = url.pathname.replace(/(?<!\/)\/+$/, '');
  return url.toString();
}

/** Stable item id: first 16 hex chars of sha256(normalized URL). */
export function itemIdFor(url: string): string {
  return createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 16);
}

/** True when both URLs normalize to the same canonical form. */
export function sameUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}
