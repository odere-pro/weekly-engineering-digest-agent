import { describe, expect, it } from 'vitest';
import { makeItem } from '../../../test/builders';
import type { EvalCases } from '../../cases/evalSet';
import { holdoutCapture, sample, weekCases } from '../__fixtures__/calibrationKit';
import { fitCalibration } from '../fit/fitCalibration';
import { weekHits } from './weekHits';

const thresholds = { minRelevance: 0, maxHype: 1, maxMinorRelease: 1, guardFlag: 0.5 };

describe('weekHits', () => {
  it('lists the items the process step picks next to the week labels', () => {
    // x1 scores 1, x2 scores 2: with room for one item, x2 wins.
    const hits = weekHits(holdoutCapture(), weekCases(), thresholds, null, 1);

    expect(hits).toEqual([
      {
        mustInclude: ['x1'],
        mustExclude: ['x2'],
        digestItemIds: ['x2'],
        visibleIds: new Set(['x1', 'x2']),
      },
    ]);
  });

  it('picks both items when there is room for both', () => {
    const [week] = weekHits(holdoutCapture(), weekCases(), thresholds, null, 5);

    expect([...(week?.digestItemIds ?? [])].sort()).toEqual(['x1', 'x2']);
  });

  it('applies the calibration to the ranking', () => {
    const flipped = fitCalibration([sample(1, 3), sample(2, 0)], 'light');

    const [week] = weekHits(holdoutCapture(), weekCases(), thresholds, flipped, 1);

    expect(week?.digestItemIds).toEqual(['x1']);
  });

  it('leaves out a week with no captured item', () => {
    const cases = weekCases();
    const idle = { ...cases.weeks[0]!, weekId: '2026-W41' };

    const hits = weekHits(
      holdoutCapture(),
      { ...cases, weeks: [idle, ...cases.weeks] },
      thresholds,
      null,
      5,
    );

    expect(hits).toHaveLength(1);
  });

  it('skips a failed call and a record whose item the week does not have', () => {
    const capture = holdoutCapture();
    const [first, second] = capture.weekItems;
    const withGaps = {
      ...capture,
      weekItems: [
        { ...first!, result: { error: 'boom' } },
        { ...second!, itemId: 'unknown' },
      ],
    };
    const cases: EvalCases = {
      ...weekCases(),
      weeks: [{ ...weekCases().weeks[0]!, items: ['x1', 'x2'].map((id) => makeItem({ id })) }],
    };

    const [week] = weekHits(withGaps, cases, thresholds, null, 5);

    expect(week?.digestItemIds).toEqual([]);
    expect(week?.visibleIds).toEqual(new Set());
  });
});
