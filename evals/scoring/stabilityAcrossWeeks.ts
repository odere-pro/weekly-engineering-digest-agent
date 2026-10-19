import { noDigestCause } from '../metrics/guards/guardRealBlocks';
import type { Measurement } from '../metrics/measurement/measurement';
import { stability } from '../metrics/run/stability';
import type { WeekDetail } from '../schema';
import type { StabilityWeek } from './types';

/**
 * The gate keeps its meaning: the value, the note, the detail and `itemIdsByRun` are the first
 * week's, as in the earlier scorecards. When more weeks were replayed, `byWeek` adds each week's
 * own overlap; a week with an empty run is `no-digest`, which the scorecard text lists.
 */
export function stabilityAcrossWeeks(weeks: readonly StabilityWeek[]): Measurement {
  const [first] = weeks;
  if (!first) return stability([]);
  const base = stability(first.runs, first.weekId);
  if (weeks.length === 1) return base;
  const byWeek = Object.fromEntries(
    weeks.map(({ weekId, runs, replays }): [string, WeekDetail] => {
      const empty = runs.filter((ids) => ids.length === 0).length;
      const causes = replays.flatMap((r, i) =>
        runs[i]?.length === 0 ? [`run ${i + 1}: ${noDigestCause(r.record)}`] : [],
      );
      const overlap = stability(runs, weekId).value ?? 0;
      return [
        weekId,
        {
          status: empty === 0 ? 'ok' : 'no-digest',
          problems: [
            `overlap ${overlap.toFixed(2)} items over ${runs.length} runs, ${empty} empty`,
            ...causes,
          ],
          problemCount: empty,
        },
      ];
    }),
  );
  return { ...base, byWeek };
}
