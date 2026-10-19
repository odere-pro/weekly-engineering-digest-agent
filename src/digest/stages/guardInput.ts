import { guardInputStep } from '../../guards/guardInput';
import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';

/** The input guards over the collected items; the ones they let through go on. */
export async function guardInput(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { inputGuards, config } = ctx.deps;
  const { kept, dropped } = await guardInputStep(state.collected, {
    guards: inputGuards,
    config: config.guards.input,
    logger,
    signal: ctx.signal,
  });
  logger.info('Input guards done', { kept: kept.length, dropped: dropped.length });
  return { ...state, kept };
}
