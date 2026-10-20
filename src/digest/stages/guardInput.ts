import { guardInputStep } from '../../guards/guardInput';
import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { modelGuardsFirst } from './modelGuardsFirst';

/**
 * The rule guard over every collected item; the items it lets through go on to classify. The
 * model guards run after `process`, on the candidates (`guardCandidates`), unless
 * `modelGuardsFirst` keeps them here.
 */
export async function guardInput(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { inputGuards, config } = ctx.deps;
  const { kept, dropped } = await guardInputStep(state.collected, {
    guards: inputGuards,
    modelGuards: modelGuardsFirst(config),
    config: config.guards.input,
    logger,
    signal: ctx.signal,
    clock: ctx.deps.clock,
  });
  logger.info('Input guards done', { kept: kept.length, dropped: dropped.length });
  return { ...state, kept };
}
