import type { ScoredItem } from '../../classify/classification';
import { DIGEST_MIN_ITEMS } from '../../checks/formatCheck';
import { guardCandidatesStep, type PickCandidates } from '../../guards/guardCandidates';
import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { modelGuardsFirst } from './modelGuardsFirst';
import { processorFor } from './processWith';

/** The process step again without the flagged items: its picks, then the rest in rank order. */
async function processPicks(
  ctx: RunContext,
  state: ChainState,
): Promise<PickCandidates<ScoredItem>> {
  const process = await processorFor(ctx);
  return (flagged) => {
    const { selected, belowTopN } = process(state.scored.filter((item) => !flagged.has(item)));
    return { picks: selected, next: belowTopN };
  };
}

/**
 * The model input guards over the items `process` picked (PERF-2). A flagged pick makes way for the
 * next item `process` ranks, which is checked in turn. Fewer than `DIGEST_MIN_ITEMS` left settles
 * the run as quiet, with no note, as `process` does.
 */
export async function guardCandidates(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { config, inputGuards } = ctx.deps;
  if (modelGuardsFirst(config)) return state;
  const { kept, dropped, checked, rounds } = await guardCandidatesStep(
    await processPicks(ctx, state),
    {
      guards: inputGuards,
      config: config.guards.input,
      logger,
      signal: ctx.signal,
      clock: ctx.deps.clock,
    },
  );
  logger.info('Candidate guards done', {
    kept: kept.length,
    dropped: dropped.length,
    checked,
    rounds,
  });
  const next = { ...state, selected: kept, guardedCandidates: checked };
  if (kept.length >= DIGEST_MIN_ITEMS) return next;
  logger.info('Quiet week: too few items for a digest', { needed: DIGEST_MIN_ITEMS });
  return { ...next, settled: { status: 'quiet' } };
}
