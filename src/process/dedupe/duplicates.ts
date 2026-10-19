import { normalizeText } from '../normalizeText';
import type { Entry } from '../types';
import { releaseKeyOf } from './releaseKey';

/** Source ids that already have a kept entry for one story key. */
type SourcesByKey = Map<string, ReadonlySet<string>>;

/**
 * Entries that repeat a better-ranked one: same id, or, from a different source, the same
 * normalized title or the same release (product name plus version token in the title).
 * `survivors` is in rank order, so the first of each story is the one kept.
 */
export function duplicates(survivors: readonly Entry[]): (entry: Entry) => boolean {
  const repeats = new Set<Entry>();
  const keptIds = new Set<string>();
  const byTitle: SourcesByKey = new Map();
  const byRelease: SourcesByKey = new Map();

  for (const entry of survivors) {
    const { id, sourceId, title } = entry.item;
    const titleKey = normalizeText(title);
    const releaseKey = releaseKeyOf(title);

    if (
      keptIds.has(id) ||
      repeatsFromOtherSource(byTitle, titleKey, sourceId) ||
      repeatsFromOtherSource(byRelease, releaseKey, sourceId)
    ) {
      repeats.add(entry);
      continue;
    }
    keptIds.add(id);
    rememberSource(byTitle, titleKey, sourceId);
    rememberSource(byRelease, releaseKey, sourceId);
  }
  return (entry) => repeats.has(entry);
}

/** A blank key never matches anything. */
function repeatsFromOtherSource(index: SourcesByKey, key: string, sourceId: string): boolean {
  const sources = key === '' ? undefined : index.get(key);
  return sources !== undefined && [...sources].some((source) => source !== sourceId);
}

function rememberSource(index: SourcesByKey, key: string, sourceId: string): void {
  if (key !== '') index.set(key, new Set(index.get(key)).add(sourceId));
}
