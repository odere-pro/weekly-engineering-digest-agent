import { collectStep } from '../../sources/collect';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { PartialFailure } from '../chain/failures';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { toJson } from '../ending/runFiles/runFiles';
import { keepArtifact } from './keepArtifact';

const DAY_MS = 86_400_000;

/**
 * Reads the sources over the run's window. No items at all settles the run as quiet, unless every
 * source failed: that is a broken network or DNS, not a quiet week, so the step fails and the
 * run can be retried.
 */
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
    { fetchers, logger, clock, signal: ctx.signal },
  );
  const held = await keepArtifact(ctx, state, 'items.json', toJson(items));
  logger.info('Collected items', { items: items.length, failedSources: failedSources.length });
  const next = { ...held, collected: items, failedSources };
  if (items.length > 0) return next;
  const total = config.sources.length;
  if (total > 0 && failedSources.length === total) {
    // Counts only: each feed's error text stays in the record's failedSources, never in the note.
    const cause = new DigestError(
      `every source failed (${total} of ${total} sources), so no items were collected`,
      { step: 'collect' },
    );
    throw new PartialFailure(next, cause);
  }
  const detail =
    failedSources.length > 0 ? ` (${failedSources.length} of ${total} sources failed)` : '';
  return { ...next, settled: { status: 'quiet', note: `no items collected${detail}` } };
}
