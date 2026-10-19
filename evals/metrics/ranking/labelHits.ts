import { measured, type Measurement } from '../measurement/measurement';
import { mean } from '../measurement/numbers';

/** One week: the maintainer's labels and the items the digest linked to. */
export interface WeekHits {
  mustInclude: readonly string[];
  mustExclude: readonly string[];
  digestItemIds: readonly string[];
  /**
   * The items the replay served. A label outside it is not visible: it cannot be found in the
   * digest, so it is not counted as found and is reported in `detail.notVisible`. A must-include
   * label that is not visible lowers that week's best possible recall. Absent: all are visible.
   */
  visibleIds?: ReadonlySet<string>;
}

function hitsPerWeek(
  weeks: readonly WeekHits[],
  pick: (week: WeekHits) => readonly string[],
): Measurement {
  const counted = weeks.map((week) => {
    const { digestItemIds, visibleIds } = week;
    const labeled = pick(week);
    const visible = visibleIds ? labeled.filter((id) => visibleIds.has(id)) : labeled;
    const found = visible.filter((id) => digestItemIds.includes(id)).length;
    return { found, notVisible: labeled.length - visible.length };
  });
  const notVisible = counted.reduce((sum, week) => sum + week.notVisible, 0);
  const value = mean(counted.map((week) => week.found));
  if (notVisible === 0) return measured(value);
  return {
    value,
    detail: { notVisible },
    note: `${notVisible} labeled item(s) fall outside the replay window: they can be neither found nor leak`,
  };
}

/** Mean number of must-include items found in the digest per week. */
export function mustIncludeRecall(weeks: readonly WeekHits[]): Measurement {
  return hitsPerWeek(weeks, (w) => w.mustInclude);
}

/** Mean number of must-exclude items that leaked into the digest per week. */
export function mustExcludeLeaks(weeks: readonly WeekHits[]): Measurement {
  return hitsPerWeek(weeks, (w) => w.mustExclude);
}
