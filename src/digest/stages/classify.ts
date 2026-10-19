import { areaHintsOf, classifyStep } from '../../classify/classify';
import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { toJson } from '../ending/runFiles/runFiles';
import { keepArtifact } from './keepArtifact';

/**
 * Scores every kept item. `models.rescoreWithWriter` (off by default) has the writer model score
 * the items at or above `thresholds.minRelevance` once more; the floor is the process step's own.
 */
export async function classify(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { model, config } = ctx.deps;
  const scored = await classifyStep(state.kept, {
    model,
    focusAreas: config.focusAreas,
    logger,
    areaHints: areaHintsOf(config.sources),
    rescoreWithWriter: config.models.rescoreWithWriter,
    minRelevance: config.thresholds.minRelevance,
    signal: ctx.signal,
  });
  const classifications = scored.map((item) => item.classification);
  const held = await keepArtifact(ctx, state, 'scores.json', toJson(classifications));
  return { ...held, scored };
}
