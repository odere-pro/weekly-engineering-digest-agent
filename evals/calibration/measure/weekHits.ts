import type { ScoredItem } from '../../../src/classify/classification';
import type { Thresholds } from '../../../src/config/schema';
import type { Calibration } from '../../../src/process/calibration';
import { processStep } from '../../../src/process/process';
import type { EvalCases } from '../../cases/evalSet';
import type { WeekHits } from '../../metrics/ranking/labelHits';
import { isFailed, type RawCapture } from '../../thresholds/capture/schemas';

/**
 * Per recorded week that has captured items: the process step's top `topN` (with the file when
 * given) next to the week's labels. A week with no captured items, a record without a recorded
 * item and a failed call are left out.
 */
export function weekHits(
  side: RawCapture,
  cases: EvalCases,
  thresholds: Thresholds,
  calibration: Calibration | null,
  topN: number,
): WeekHits[] {
  return cases.weeks.flatMap((week) => {
    const records = side.weekItems.filter((r) => r.weekId === week.weekId);
    if (records.length === 0) return [];
    const scored = records.flatMap((record): ScoredItem[] => {
      const item = week.items.find((i) => i.id === record.itemId);
      if (!item || isFailed(record.result)) return [];
      return [{ ...item, classification: { itemId: item.id, ...record.result } }];
    });
    const { selected } = processStep({
      items: scored,
      sentUrls: new Set(),
      thresholds,
      topN,
      calibration: calibration ?? undefined,
    });
    return [
      {
        mustInclude: week.labels.mustInclude,
        mustExclude: week.labels.mustExclude,
        digestItemIds: selected.map((item) => item.id),
        visibleIds: new Set(scored.map((item) => item.id)),
      },
    ];
  });
}
