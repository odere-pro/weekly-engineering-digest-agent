import { rescoreBatch, type Rescore } from './rescoreBatch';
import { chunk } from '../batching/chunk';
import { BATCH_SIZE, GENERATED_AREA_CONFIDENCE } from '../batching/limits';
import type { ScoredItem } from '../classification';
import type { ClassifierDeps } from '../types';

/**
 * Sends the items whose relevance reached `minRelevance` to the writer model in batches of 10.
 * A batch that fails keeps the decider's scores for its items. Returns every item, in order.
 */
export async function rescoreFiltered(
  scored: readonly ScoredItem[],
  minRelevance: number,
  deps: ClassifierDeps,
): Promise<ScoredItem[]> {
  const passed = scored.filter((item) => item.classification.relevance >= minRelevance);
  const rescored = new Map<string, Rescore>();
  for (const batch of chunk(passed, BATCH_SIZE)) {
    for (const [itemId, rescore] of await rescoreBatch(batch, deps)) rescored.set(itemId, rescore);
  }
  deps.logger.info('Rescored items with the writer model', {
    sent: passed.length,
    rescored: rescored.size,
  });
  return scored.map((item) => withRescore(item, rescored.get(item.id)));
}

/** Hype and minor-release stay the decider's; the writer sets relevance, and area when sure. */
function withRescore(item: ScoredItem, rescore: Rescore | undefined): ScoredItem {
  if (rescore === undefined) return item;
  const { classification } = item;
  return {
    ...item,
    classification: {
      ...classification,
      relevance: rescore.relevance,
      ...(rescore.confidentArea
        ? { area: rescore.area, areaConfidence: GENERATED_AREA_CONFIDENCE }
        : {}),
    },
  };
}
