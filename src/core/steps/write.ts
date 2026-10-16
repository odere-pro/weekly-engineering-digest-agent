import type { Draft, ScoredItem } from '../schemas.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';

export interface WriteDeps {
  model: ModelProvider;
  /** Writer model tags in config order; drafted one after another. */
  writers: readonly string[];
  focusAreas: readonly string[];
  weekId: string;
  logger: Logger;
}

export interface WriteOutput {
  drafts: Draft[];
  failures: { writer: string; error: string }[];
}

/** Each writer drafts the digest from the same top items (W1-09). */
export function writeStep(_items: readonly ScoredItem[], _deps: WriteDeps): Promise<WriteOutput> {
  throw new NotImplementedError('W1-09');
}
