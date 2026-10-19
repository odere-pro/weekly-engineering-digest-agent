import { chunk } from './chunk';
import { BATCH_SIZE } from './limits';
import { scoreBatch } from './scoreBatch';
import type { Classification, ScoredItem } from '../classification';
import { OTHER_AREA } from '../classifyPrompt';
import type { ClassifierDeps } from '../types';
import type { Item } from '../../domain/schemas';

/**
 * Generate mode: JSON batches of 10. Items the model leaves out are retried once together in
 * their own batches; items still missing default to not relevant.
 */
export async function classifyInBatches(
  items: readonly Item[],
  deps: ClassifierDeps,
): Promise<ScoredItem[]> {
  const first = await scoreBatches(items, deps);
  const missing = items.filter((item) => !first.has(item.id));
  const retried =
    missing.length > 0 ? await scoreBatches(missing, deps) : new Map<string, Classification>();
  const scored = new Map([...first, ...retried]);
  const defaulted = items.filter((item) => !scored.has(item.id)).map((item) => item.id);
  if (defaulted.length > 0)
    deps.logger.warn('Classifier answer missing after a retry; item marked not relevant', {
      itemIds: defaulted,
    });
  return items.map((item) => ({
    ...item,
    classification: scored.get(item.id) ?? notRelevant(item.id),
  }));
}

/** Scores `items` in batches, one call at a time. The first answer for an id wins. */
async function scoreBatches(
  items: readonly Item[],
  deps: ClassifierDeps,
): Promise<Map<string, Classification>> {
  const scored = new Map<string, Classification>();
  for (const batch of chunk(items, BATCH_SIZE)) {
    for (const classification of await scoreBatch(batch, deps))
      if (!scored.has(classification.itemId)) scored.set(classification.itemId, classification);
  }
  return scored;
}

function notRelevant(itemId: string): Classification {
  return {
    itemId,
    relevance: 0,
    area: OTHER_AREA,
    areaConfidence: 0,
    hype: 0,
    minorRelease: 0,
  };
}
