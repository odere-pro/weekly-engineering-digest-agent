import type { Draft, Item, JudgeScore } from '../schemas.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';

export interface SelectDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  /** Config order of writers; ties go to the first. */
  writerOrder: readonly string[];
  logger: Logger;
}

export interface SelectOutput {
  winner: Draft;
  /** Empty when only one draft passed (judge skipped). */
  scores: JudgeScore[];
}

/** Judge scores each passing draft separately; highest wins (W1-10). */
export function selectStep(
  _drafts: readonly Draft[],
  _sources: readonly Item[],
  _deps: SelectDeps,
): Promise<SelectOutput> {
  throw new NotImplementedError('W1-10');
}
