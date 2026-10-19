import { calibrateClassification, type Calibration } from '../../../src/process/calibration';
import { isFailed, type RawCapture } from '../../thresholds/capture/schemas';

const WITHIN_ONE = 1;

/**
 * Share of the side's classifier cases whose label is within one point of the score (calibrated
 * when a file is given). Failed calls are not counted; null when no case succeeded.
 */
export function withinOneShare(side: RawCapture, calibration: Calibration | null): number | null {
  const records = side.classifier.flatMap((r) =>
    isFailed(r.result) ? [] : [{ ...r, ok: r.result }],
  );
  if (records.length === 0) return null;
  const right = records.filter(({ expected, ok }) => {
    const score = calibration
      ? calibrateClassification(calibration, { itemId: '', ...ok }).relevance
      : ok.relevance;
    return Math.abs(expected.relevance - score) <= WITHIN_ONE;
  });
  return right.length / records.length;
}
