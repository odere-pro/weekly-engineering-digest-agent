import { describe, expect, it } from 'vitest';
import type { Calibration } from '../../../src/process/calibration';
import type { RawCapture } from '../../thresholds/capture/schemas';
import { holdoutCapture } from '../__fixtures__/calibrationKit';
import { withinOneShare } from './withinOneShare';

const caseRecord = (itemId: string, expected: number, relevance: number | null) => ({
  itemId,
  expected: { area: 'a', relevance: expected },
  result:
    relevance === null
      ? { error: 'boom' }
      : { relevance, area: 'a', areaConfidence: 1, hype: 0, minorRelease: 0 },
});

const sideWith = (...records: ReturnType<typeof caseRecord>[]): RawCapture => ({
  ...holdoutCapture(),
  classifier: records,
});

const lift: Calibration = {
  version: 1,
  profile: 'light',
  points: [{ raw: 1, calibrated: 2.5 }],
  areaBias: {},
};

describe('withinOneShare', () => {
  it('is null when the side has no classifier case', () => {
    expect(withinOneShare(sideWith(), null)).toBeNull();
  });

  it('is null when every call failed', () => {
    expect(withinOneShare(sideWith(caseRecord('k', 3, null)), null)).toBeNull();
  });

  it('counts the cases whose label is one point or less from the raw score', () => {
    const side = sideWith(caseRecord('k1', 3, 2), caseRecord('k2', 3, 1), caseRecord('k3', 0, 1));

    // |3-2| = 1 and |0-1| = 1 count; |3-1| = 2 does not.
    expect(withinOneShare(side, null)).toBeCloseTo(2 / 3, 10);
  });

  it('skips failed calls instead of counting them as wrong', () => {
    const side = sideWith(caseRecord('k1', 3, 3), caseRecord('k2', 3, null));

    expect(withinOneShare(side, null)).toBe(1);
  });

  it('scores the calibrated relevance when a file is given', () => {
    const side = sideWith(caseRecord('k', 3, 1));

    expect(withinOneShare(side, null)).toBe(0);
    expect(withinOneShare(side, lift)).toBe(1);
  });
});
