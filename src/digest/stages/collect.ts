import { collectStep } from '../../sources/collect';
import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { toJson } from '../ending/runFiles/runFiles';
import { keepArtifact } from './keepArtifact';

const DAY_MS = 86_400_000;

/** Reads the sources over the run's window. No items at all settles the run as quiet. */
export async function collect(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { config, fetchers, clock } = ctx.deps;
  const until = ctx.startedAt;
  const since = new Date(until.getTime() - ctx.sinceDays * DAY_MS);
  const { items, failedSources } = await collectStep(
    { sources: config.sources, since, until, maxItemsPerSource: config.maxItemsPerSource },
    { fetchers, logger, clock },
  );
  const held = await keepArtifact(ctx, state, 'items.json', toJson(items));
  logger.info('Collected items', { items: items.length, failedSources: failedSources.length });
  const next = { ...held, collected: items, failedSources };
  if (items.length > 0) return next;
  const failed = failedSources.length > 0;
  const detail = failed
    ? ` (${failedSources.length} of ${config.sources.length} sources failed)`
    : '';
  return { ...next, settled: { status: 'quiet', note: `no items collected${detail}` } };
}
