import { normalizeUrl } from '../../shared/url';
import type { Entry } from '../types';

/**
 * Whether an entry's URL went out in a recent week. Both sides pass through `normalizeUrl`, so
 * tracking params, a fragment, a trailing slash or host case never hide a repeat.
 */
export function sentBefore(sentUrls: ReadonlySet<string>): (entry: Entry) => boolean {
  const sent = new Set([...sentUrls].map(normalizeUrl));
  return ({ item }) => sent.has(normalizeUrl(item.url));
}
