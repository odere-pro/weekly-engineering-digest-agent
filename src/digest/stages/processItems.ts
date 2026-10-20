import { DIGEST_MIN_ITEMS } from '../../checks/formatCheck';
import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { processorFor } from './processWith';

/**
 * Filters by the thresholds, drops what earlier weeks sent, ranks and cuts to the top N. Fewer
 * than `DIGEST_MIN_ITEMS` left settles the run as quiet, with no note.
 */
export async function processItems(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const process = await processorFor(ctx);
  const { selected, dropped, eligible } = process(state.scored);
  logger.info('Selected items', { selected: selected.length, dropped: dropped.length });
  const cut = dropped.filter((item) => item.reason === 'below-top-n').length;
  const next = { ...state, selected, eligible, afterProcess: selected.length + cut };
  if (selected.length >= DIGEST_MIN_ITEMS) return next;
  logger.info('Quiet week: too few items for a digest', { needed: DIGEST_MIN_ITEMS });
  return { ...next, settled: { status: 'quiet' } };
}
