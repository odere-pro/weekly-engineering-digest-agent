import { describe, expect, it } from 'vitest';
import { calibrateClassification } from '../../../src/process/calibration';
import { makeClassification } from '../../../test/builders';
import type { RawCapture } from '../../thresholds/capture/schemas';
import { holdoutCapture, sample, weekCases } from '../__fixtures__/calibrationKit';
import { fitCalibration } from '../fit/fitCalibration';
import { measureSide } from './measureSide';

describe('measureSide', () => {
  const cases = weekCases();
  const thresholds = { minRelevance: 0, maxHype: 1, maxMinorRelease: 1, guardFlag: 0.5 };

  it('counts recall and leaks in the top 5 and within-one accuracy', () => {
    const base = measureSide(holdoutCapture(), cases, thresholds, null, 1);
    expect(base.recall).toBe(0);
    expect(base.leaks).toBe(1);
    const flipped = fitCalibration([sample(1, 3), sample(2, 0)], 'light');
    const topOne = measureSide(holdoutCapture(), cases, thresholds, flipped, 1);
    expect(topOne.recall).toBe(1);
    expect(topOne.leaks).toBe(0);
  });

  it('counts the top 5 when no size is given', () => {
    const measure = measureSide(holdoutCapture(), cases, thresholds, null);

    // Both items fit: x1 is found, x2 leaks.
    expect(measure).toEqual({ recall: 1, leaks: 1, withinOne: null });
  });

  it('is 0 for recall and leaks when no recorded week has captured items', () => {
    const empty: RawCapture = { ...holdoutCapture(), weekItems: [] };

    expect(measureSide(empty, cases, thresholds, null)).toEqual({
      recall: 0,
      leaks: 0,
      withinOne: null,
    });
  });

  it('reports within-one accuracy of calibrated relevance on holdout cases', () => {
    const withCases: RawCapture = {
      ...holdoutCapture(),
      classifier: [
        {
          itemId: 'k',
          expected: { area: 'a', relevance: 3 },
          result: { relevance: 1, area: 'a', areaConfidence: 1, hype: 0, minorRelease: 0 },
        },
      ],
    };
    expect(measureSide(withCases, cases, thresholds, null, 1).withinOne).toBe(0);
    const lift = {
      version: 1 as const,
      profile: 'light' as const,
      points: [{ raw: 1, calibrated: 2.5 }],
      areaBias: {},
    };
    expect(calibrateClassification(lift, makeClassification('k', { relevance: 1 })).relevance).toBe(
      2.5,
    );
    expect(measureSide(withCases, cases, thresholds, lift, 1).withinOne).toBe(1);
  });
});
