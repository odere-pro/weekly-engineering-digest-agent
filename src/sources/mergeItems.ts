import type { Item } from '../domain/schemas';
import { normalizeUrl } from '../shared/url';

/**
 * The saved items, then the new ones whose normalized URL is not among them: for one page the
 * saved item wins. A repeat inside `fetched` keeps its first. Pure.
 */
export function mergeByUrl(saved: readonly Item[], fetched: readonly Item[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const item of [...saved, ...fetched]) {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
