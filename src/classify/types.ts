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
  /**
   * The run's abort signal: given to every model call, and no new call starts once it fires. The
   * step then rejects with the signal's reason; an aborted call is never a score, and not even
   * the writer rescore (otherwise lenient) takes it for a failed batch.
   */
  signal?: AbortSignal;
  /** This week's extra topic ("run again" with a new perspective); absent means the prompts are unchanged. */
  perspective?: string;
}
