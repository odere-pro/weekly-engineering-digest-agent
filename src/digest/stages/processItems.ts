import { DIGEST_MIN_ITEMS } from '../../checks/formatCheck';
import { processStep } from '../../process/process';
import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';

/**
 * Filters by the thresholds, drops what earlier weeks sent, ranks and cuts to the top N. Fewer
 * than `DIGEST_MIN_ITEMS` left settles the run as quiet, with no note.
 */
export async function processItems(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { config, store } = ctx.deps;
  const sentUrls = await store.sentUrls(ctx.weekId, config.dedupeWeeks);
  const { selected, dropped } = processStep({
    items: state.scored,
    sentUrls,
    thresholds: config.thresholds,
    topN: config.topN,
  });
  logger.info('Selected items', { selected: selected.length, dropped: dropped.length });
  const cut = dropped.filter((item) => item.reason === 'below-top-n').length;
  const next = { ...state, selected, afterProcess: selected.length + cut };
  if (selected.length >= DIGEST_MIN_ITEMS) return next;
  logger.info('Quiet week: too few items for a digest', { needed: DIGEST_MIN_ITEMS });
  return { ...next, settled: { status: 'quiet' } };
}
