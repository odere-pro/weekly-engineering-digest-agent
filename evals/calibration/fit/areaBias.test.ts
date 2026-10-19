import { describe, expect, it } from 'vitest';
import { sample } from '../__fixtures__/calibrationKit';
import { evaluate, fitAreaBias, type Points } from './areaBias';

/** The map that leaves every raw score as it is, from 0 to 3. */
const identity: Points = [
  { raw: 0, calibrated: 0 },
  { raw: 3, calibrated: 3 },
];

describe('evaluate', () => {
  const points: Points = [
    { raw: 1, calibrated: 0 },
    { raw: 3, calibrated: 2 },
  ];

  it('interpolates between the knots', () => {
    expect(evaluate(points, 2)).toBe(1);
  });

  it('holds the end values outside the knots', () => {
    expect(evaluate(points, 0.5)).toBe(0);
    expect(evaluate(points, 3.5)).toBe(2);
  });
});

describe('fitAreaBias', () => {
  it('shrinks the mean error by n / (n + 5)', () => {
    // Two samples a point above the map: mean error 1, shrunk to 1 * 2 / 7.
    const bias = fitAreaBias([sample(1, 2, 'Big'), sample(1, 2, 'Big')], identity);

    expect(bias['big']).toBeCloseTo(2 / 7, 10);
  });

  it('caps the bias at 0.5 in both directions', () => {
    const up = Array.from({ length: 20 }, () => sample(0, 3, 'Up'));
    const down = Array.from({ length: 20 }, () => sample(3, 0, 'Down'));

    const bias = fitAreaBias([...up, ...down], identity);

    expect(bias).toEqual({ up: 0.5, down: -0.5 });
  });

  it('groups areas by trimmed lowercase name', () => {
    const bias = fitAreaBias([sample(1, 2, ' Big '), sample(1, 2, 'BIG')], identity);

    expect(Object.keys(bias)).toEqual(['big']);
  });

  it('is empty for no sample', () => {
    expect(fitAreaBias([], identity)).toEqual({});
  });
});
