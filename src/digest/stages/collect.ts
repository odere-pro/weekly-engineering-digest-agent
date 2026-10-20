import { collectStep } from '../../sources/collect';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { PartialFailure } from '../chain/failures';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { toJson } from '../ending/runFiles/runFiles';
import { keepArtifact } from './keepArtifact';

const DAY_MS = 86_400_000;
/** The longest window there is: `windowDays` and `--since` stop at 31 days too. */
const MAX_WINDOW_DAYS = 31;

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
  const since = windowStart(ctx, logger);
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

/**
 * `sinceDays` before the run's start, or the start of the last delivered run when that is earlier:
 * it collected up to there, so a late run (a catch-up, a retry) misses nothing in between. Never
 * more than 31 days back. Items both runs saw are dropped later by the cross-week dedupe.
 */
function windowStart(ctx: RunContext, logger: Logger): Date {
  const until = ctx.startedAt.getTime();
  const usual = until - ctx.sinceDays * DAY_MS;
  const lastStart = Date.parse(ctx.lastDelivered?.startedAt ?? '');
  // No earlier delivered run, or one that started inside the usual window.
  if (Number.isNaN(lastStart) || lastStart >= usual) return new Date(usual);
  const since = new Date(Math.max(lastStart, until - MAX_WINDOW_DAYS * DAY_MS));
  logger.info('Collecting from where the last delivered run stopped', {
    since: since.toISOString(),
    lastDelivered: ctx.lastDelivered?.runId,
  });
  return since;
}
