// The "Item ids by run" block of the scorecard: what each repeated run of a week picked.
import type { MetricResult } from '../../../../evals/schema';
import { plural, safeText } from './printable';

export const SHORT_ID_CHARS = 8;
export const ITEM_IDS_TITLE = `Item ids by run (first ${SHORT_ID_CHARS} characters; the scorecard file has them in full):`;

/** The id evals/metrics gives a digest link that matches no collected item: `unmatched:<url>`. */
const UNMATCHED_ID_PREFIX = 'unmatched:';
const UNMATCHED_ID_TEXT = 'unmatched';

/** A link that matched no item carries the URL the model wrote; show that it was invented, not it. */
function shortId(id: string): string {
  if (id.startsWith(UNMATCHED_ID_PREFIX)) return UNMATCHED_ID_TEXT;
  return Array.from(safeText(id)).slice(0, SHORT_ID_CHARS).join('');
}

function runText(ids: readonly string[]): string {
  if (ids.length === 0) return 'no items';
  const shortIds = ids.map(shortId).join(' ');
  return `${plural(ids.length, 'item')}: ${shortIds}`;
}

/** Stability: what each run picked, so empty digests and different picks can be told apart. */
export function itemIdsByRunLines(metrics: readonly MetricResult[]): string[] {
  return metrics.flatMap((metric) =>
    (metric.itemIdsByRun ?? []).map(
      (ids, run) => `  ${metric.label} run ${run + 1}: ${runText(ids)}`,
    ),
  );
}
