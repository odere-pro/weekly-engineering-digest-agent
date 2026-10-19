import { describe, expect, it } from 'vitest';
import { MARGIN_STEPS, PROBABILITY_AXIS, RELEVANCE_AXIS, axisValues, pickOnGrid } from './grid';

describe('axisValues', () => {
  it('lists every grid value from min to max without floating-point drift', () => {
    expect(axisValues({ min: 0, max: 1, step: 0.25 })).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(axisValues({ min: 0, max: 3, step: 0.05 })).toHaveLength(61);
    expect(axisValues({ min: 0, max: 3, step: 0.05 })).toContain(2);
  });

  it('lands 0.05 steps on 0.15, not 0.15000000000000002', () => {
    expect(axisValues(PROBABILITY_AXIS)).toContain(0.15);
    expect(axisValues(PROBABILITY_AXIS)).toHaveLength(21);
  });

  it('gives one value for an axis whose min and max are equal', () => {
    expect(axisValues({ min: 0.7, max: 0.7, step: 0.05 })).toEqual([0.7]);
  });

  it('searches relevance from 0 to 3 and probabilities from 0 to 1', () => {
    expect([RELEVANCE_AXIS.min, RELEVANCE_AXIS.max]).toEqual([0, 3]);
    expect([PROBABILITY_AXIS.min, PROBABILITY_AXIS.max]).toEqual([0, 1]);
  });
});

describe('pickOnGrid', () => {
  const axis = axisValues({ min: 0, max: 1, step: 0.1 });
  // Best (1) from 0.2 to 0.8; with two steps of margin on each side, 0.4 to 0.6.
  const score = ({ x }: Readonly<Record<'x', number>>): number =>
    x >= 0.2 - 1e-9 && x <= 0.8 + 1e-9 ? 1 : 0;

  it('picks the best-scoring point with the best-scoring neighbours, closest to the preferred value', () => {
    expect(pickOnGrid({ x: { values: axis, preferred: 0 } }, score).point).toEqual({ x: 0.4 });
    expect(pickOnGrid({ x: { values: axis, preferred: 1 } }, score).point).toEqual({ x: 0.6 });
    expect(pickOnGrid({ x: { values: axis, preferred: 0.5 } }, score)).toEqual({
      point: { x: 0.5 },
      score: 1,
    });
  });

  it('keeps a dimension with a single value fixed', () => {
    const dims = { x: { values: axis, preferred: 0 }, fixed: { values: [0.7], preferred: 0.2 } };
    expect(pickOnGrid(dims, score).point).toEqual({ x: 0.4, fixed: 0.7 });
  });

  it('searches every dimension at once and returns the best score', () => {
    const dims = { x: { values: axis, preferred: 0.5 }, y: { values: axis, preferred: 0.5 } };
    const peak = ({ x, y }: Readonly<Record<'x' | 'y', number>>): number =>
      x === 0.3 && y === 0.9 ? 5 : 1;
    expect(pickOnGrid(dims, peak)).toEqual({ point: { x: 0.3, y: 0.9 }, score: 5 });
  });

  it('scores each grid point once, however many neighbourhoods it sits in', () => {
    let calls = 0;
    pickOnGrid({ x: { values: axis, preferred: 0 } }, (point) => {
      calls += 1;
      return score(point);
    });
    expect(calls).toBe(axis.length);
  });

  it('prefers the middle of a wide best range to a lone best point, whatever the preferred value', () => {
    expect(MARGIN_STEPS).toBe(2);
    // Best (1) on 0.2 to 0.6 and at 0.9 alone; 0.9 has a 0.25 neighbourhood mean, 0.4 has 1.
    const twoPeaks = ({ x }: Readonly<Record<'x', number>>): number =>
      (x >= 0.2 - 1e-9 && x <= 0.6 + 1e-9) || x === 0.9 ? 1 : 0;
    expect(pickOnGrid({ x: { values: axis, preferred: 0.9 } }, twoPeaks).point).toEqual({ x: 0.4 });
  });
});
