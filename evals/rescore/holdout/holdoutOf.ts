import type { EvalCases } from '../../cases/evalSet';
import { CASE_STRIDE } from '../../thresholds/split';

/** The holdout split of W6-04: the named weeks and every third classifier case (the 3rd, 6th, ...). */
export function holdoutOf(cases: EvalCases, weeks: readonly string[]): EvalCases {
  return {
    ...cases,
    weeks: cases.weeks.filter((week) => weeks.includes(week.weekId)),
    classifier: {
      ...cases.classifier,
      cases: cases.classifier.cases.filter((_, i) => i % CASE_STRIDE === CASE_STRIDE - 1),
    },
  };
}
