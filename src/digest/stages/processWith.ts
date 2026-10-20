import type { ScoredItem } from '../../classify/classification';
import { processStep, type ProcessOutput } from '../../process/process';
import { normalizeUrl } from '../../shared/url';
import type { RunContext } from '../chain/runContext';

/**
 * The process step with the run's thresholds and top N and the URLs earlier weeks sent, read once.
 * `process` and `guardCandidates` both pick through it, so their picks cannot drift apart.
 */
export async function processorFor(
  ctx: RunContext,
): Promise<(items: readonly ScoredItem[]) => ProcessOutput> {
  const { config, store } = ctx.deps;
  const sentUrls = await store.sentUrls(ctx.weekId, config.dedupeWeeks);
  const keep = ctx.variant?.keepUrls;
  const boostUrls = keep && new Set(keep.map(normalizeUrl));
  return (items) =>
    processStep({ items, sentUrls, thresholds: config.thresholds, topN: config.topN, boostUrls });
}
