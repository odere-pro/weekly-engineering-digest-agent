// The filter checked against the maintainer's week labels: of the items labelled must-include,
// how many the thresholds keep, and of the must-exclude ones, how many they drop.
import { isFailed, type WeekItemRecord } from '../capture/schemas';
import { keepsItem, type FilterThresholds } from '../sweep/keepsItem';
import type { WeekCheck } from './schema';

export function weekCheck(
  records: readonly WeekItemRecord[],
  thresholds: FilterThresholds,
): WeekCheck {
  const answered = records.flatMap(({ label, result }) =>
    isFailed(result) ? [] : [{ label, kept: keepsItem(result, thresholds) }],
  );
  const labelled = (label: WeekItemRecord['label']) => answered.filter((a) => a.label === label);
  return {
    items: answered.length,
    kept: answered.filter((a) => a.kept).length,
    mustInclude: labelled('mustInclude').length,
    mustIncludeKept: labelled('mustInclude').filter((a) => a.kept).length,
    mustExclude: labelled('mustExclude').length,
    mustExcludeDropped: labelled('mustExclude').filter((a) => !a.kept).length,
  };
}
