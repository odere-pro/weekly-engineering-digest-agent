import { describe, expect, it } from 'vitest';
import { calibrateClassification, CalibrationSchema, type Calibration } from './calibration';
import { processStep } from './process';
import { makeClassification, makeScoredItem } from '../../test/builders';

const calibration: Calibration = {
  version: 1,
  profile: 'light',
  points: [
    { raw: 1, calibrated: 0.5 },
    { raw: 2, calibrated: 1.5 },
    { raw: 3, calibrated: 3 },
  ],
  areaBias: { platform: -0.25 },
};

const thresholds = { minRelevance: 1, maxHype: 1, maxMinorRelease: 1, guardFlag: 0.35 };

describe('CalibrationSchema', () => {
  it('accepts a monotone mapping', () => {
    expect(CalibrationSchema.safeParse(calibration).success).toBe(true);
  });

  it('rejects raw values that do not increase', () => {
    const bad = { ...calibration, points: [calibration.points[1], calibration.points[0]] };
    expect(CalibrationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects calibrated values that fall as raw rises', () => {
    const bad = {
      ...calibration,
      points: [
        { raw: 1, calibrated: 2 },
        { raw: 2, calibrated: 1 },
      ],
    };
    expect(CalibrationSchema.safeParse(bad).success).toBe(false);
  });
});

describe('calibrateClassification', () => {
  const at = (relevance: number, area = 'AI models') =>
    calibrateClassification(calibration, makeClassification('a', { relevance, area })).relevance;

  it('interpolates between points', () => {
    expect(at(1.5)).toBeCloseTo(1);
  });

  it('clamps outside the fitted range', () => {
    expect(at(0)).toBeCloseTo(0.5);
    expect(at(3)).toBeCloseTo(3);
  });

  it('adds the area bias, matching the area case-insensitively', () => {
    expect(at(2, ' Platform ')).toBeCloseTo(1.25);
  });

  it('keeps the result inside 0 to 3', () => {
    expect(at(3, 'AI models')).toBeLessThanOrEqual(3);
    const low = { ...calibration, areaBias: { x: -5 } };
    expect(calibrateClassification(low, makeClassification('a', { area: 'x' })).relevance).toBe(0);
  });

  it('is monotone in the raw score', () => {
    const grid = Array.from({ length: 31 }, (_, i) => at(i / 10));
    expect(grid).toEqual([...grid].sort((a, b) => a - b));
  });

  it('does not mutate its input and keeps the other fields', () => {
    const input = makeClassification('a', { relevance: 2 });
    const out = calibrateClassification(calibration, input);
    expect(input.relevance).toBe(2);
    expect(out).toEqual({ ...input, relevance: out.relevance });
  });

  it('works with a single point', () => {
    const one = { ...calibration, points: [{ raw: 2, calibrated: 1.7 }], areaBias: {} };
    expect(calibrateClassification(one, makeClassification('a', { relevance: 0 })).relevance).toBe(
      1.7,
    );
  });
});

describe('processStep with calibration', () => {
  const scoredItems = [
    makeScoredItem({ id: 'low' }, { relevance: 1.2 }),
    makeScoredItem({ id: 'high' }, { relevance: 2.8 }),
  ];
  const items = () => scoredItems;
  const run = (c?: Calibration) =>
    processStep({
      items: items(),
      sentUrls: new Set(),
      thresholds: { ...thresholds, minRelevance: 1.2 },
      topN: 5,
      ...(c ? { calibration: c } : {}),
    });

  it('is identical to the old result when absent or undefined', () => {
    const base = run();
    const undef = processStep({
      items: items(),
      sentUrls: new Set(),
      thresholds: { ...thresholds, minRelevance: 1.2 },
      topN: 5,
      calibration: undefined,
    });
    expect(JSON.stringify(undef)).toBe(JSON.stringify(base));
    expect(base.selected.map((i) => i.classification.relevance)).toEqual([2.8, 1.2]);
  });

  it('ranks and filters on the calibrated score', () => {
    const out = run(calibration);
    expect(out.dropped).toEqual([{ itemId: 'low', reason: 'low-relevance' }]);
    expect(out.selected.map((i) => i.id)).toEqual(['high']);
    expect(out.selected[0]?.classification.relevance).toBeCloseTo(2.7);
  });
});
