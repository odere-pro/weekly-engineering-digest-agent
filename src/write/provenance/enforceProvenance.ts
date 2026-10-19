import type { DigestItem } from '../../domain/schemas';
import type { ScoredItem } from '../../classify/classification';
import type { Logger } from '../../shared/telemetry';
import type { WrittenItem } from '../writerSchema';
import { loggedId } from './loggedId';

/**
 * Keeps only items that point at a collected item, once each, with the source URL.
 * The model can name an item but never choose where its link goes.
 */
export function enforceProvenance(
  drafted: readonly WrittenItem[],
  sources: ReadonlyMap<string, ScoredItem>,
  logger: Logger,
): DigestItem[] {
  const seen = new Set<string>();
  return drafted.flatMap((item) => {
    const source = sources.get(item.itemId);
    if (!source) {
      logger.warn('Removed digest item with unknown itemId', { itemId: loggedId(item.itemId) });
      return [];
    }
    if (seen.has(item.itemId)) {
      logger.warn('Removed repeated digest item', { itemId: loggedId(item.itemId) });
      return [];
    }
    seen.add(item.itemId);
    return [withSourceUrl(item, source)];
  });
}

/** The source url, and the action trimmed: good-to-know items carry none, not an empty string. */
export function withSourceUrl(item: WrittenItem, source: ScoredItem): DigestItem {
  const { action, ...rest } = item;
  const trimmed = action.trim();
  return { ...rest, url: source.url, ...(trimmed === '' ? {} : { action: trimmed }) };
}
