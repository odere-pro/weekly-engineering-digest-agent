import type { Item, ScoredItem } from '../schemas.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';

export interface ClassifyDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  logger: Logger;
  /** decide: one decision call per item (default). generate: JSON batches of 10 (fallback). */
  mode?: 'decide' | 'generate';
}

/** Scores relevance, area, hype and minor release for every item (W1-07). */
export function classifyStep(_items: readonly Item[], _deps: ClassifyDeps): Promise<ScoredItem[]> {
  throw new NotImplementedError('W1-07');
}
