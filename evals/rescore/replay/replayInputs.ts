import { areaHintsOf, type ClassifyDeps } from '../../../src/classify/classify';
import type { Config } from '../../../src/config/schema';
import type { Item } from '../../../src/domain/schemas';
import type { RescoreReplayDeps } from './types';

/** Like the real fetchers: a source's newest items first, at most its cap. */
export function servedItems(items: readonly Item[], config: Config): Item[] {
  return [...new Set(items.map((item) => item.sourceId))].flatMap((sourceId) => {
    const cap =
      config.sources.find((source) => source.id === sourceId)?.maxItems ?? config.maxItemsPerSource;
    return items
      .filter((item) => item.sourceId === sourceId)
      .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, cap);
  });
}

/** What the classify step gets: the config's focus areas, area hints and relevance floor. */
export function classifyDeps(deps: RescoreReplayDeps, rescore: boolean): ClassifyDeps {
  const { config } = deps;
  return {
    model: deps.model,
    focusAreas: config.focusAreas,
    logger: deps.logger,
    areaHints: areaHintsOf(config.sources),
    rescoreWithWriter: rescore,
    minRelevance: config.thresholds.minRelevance,
  };
}
