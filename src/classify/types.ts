import type { ModelProvider } from '../models/ModelProvider';
import type { Logger } from '../shared/telemetry';

/**
 * What every scoring path reads: the model, the focus areas, a logger and the optional source tags.
 * `ClassifyDeps` (`classify.ts`) adds the options only the entry reads.
 */
export interface ClassifierDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  logger: Logger;
  /** Source id to area tag. A source without an entry gets the same prompt as before. */
  areaHints?: ReadonlyMap<string, string>;
}
