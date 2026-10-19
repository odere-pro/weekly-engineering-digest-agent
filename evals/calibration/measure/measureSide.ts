import type { Thresholds } from '../../../src/config/schema';
import type { Calibration } from '../../../src/process/calibration';
import type { EvalCases } from '../../cases/evalSet';
import { mustExcludeLeaks, mustIncludeRecall } from '../../metrics/ranking/labelHits';
import type { RawCapture } from '../../thresholds/capture/schemas';
import { weekHits } from './weekHits';
import { withinOneShare } from './withinOneShare';

/** Spec: must-include recall is counted in the top 5. */
const TOP_N = 5;

export interface SideMeasure {
  /** Mean must-include items in the top 5 per week. */
  recall: number;
  /** Mean must-exclude items in the top 5 per week. */
  leaks: number;
  /** Share of cases with |label - score| of 1 or less. */
  withinOne: number | null;
}

/** Recall, leaks and within-one accuracy of one side of a capture, with or without the file. */
export function measureSide(
  side: RawCapture,
  cases: EvalCases,
  thresholds: Thresholds,
  calibration: Calibration | null,
  topN: number = TOP_N,
): SideMeasure {
  const hits = weekHits(side, cases, thresholds, calibration, topN);
  return {
    recall: mustIncludeRecall(hits).value ?? 0,
    leaks: mustExcludeLeaks(hits).value ?? 0,
    withinOne: withinOneShare(side, calibration),
  };
}
