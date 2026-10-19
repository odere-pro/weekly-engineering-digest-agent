import { describe, expect, it } from 'vitest';
import { classifierAccuracy, classifierRanking } from './classifier';

describe('classifierAccuracy', () => {
  const result = (
    expectedArea: string,
    expectedRelevance: number,
    area: string,
    relevance: number,
  ) => ({
    expected: { area: expectedArea, relevance: expectedRelevance },
    actual: { area, relevance },
  });

  it('counts a case right only when area and relevance both match', () => {
    const measurement = classifierAccuracy([
      result('Platform', 3, 'Platform', 2.8),
      result('Platform', 3, 'AI', 3),
      result('AI', 1, 'AI', 2.4),
      result('AI', 0, 'AI', 0.2),
    ]);
    expect(measurement.value).toBe(0.5);
    expect(measurement.detail).toEqual({ area: 0.75, relevance: 0.75 });
  });

  it('compares areas ignoring case and padding', () => {
    expect(classifierAccuracy([result('Platform', 2, '  platform ', 2)]).value).toBe(1);
  });

  it('does not let floating-point noise turn a half-point miss into a wrong answer', () => {
    expect(classifierAccuracy([result('A', 1.7, 'A', 2.2)]).value).toBe(1);
  });

  it('accepts a relevance within half a point', () => {
    expect(classifierAccuracy([result('A', 2, 'A', 1.5), result('A', 2, 'A', 2.5)]).value).toBe(1);
    expect(classifierAccuracy([result('A', 2, 'A', 1.4)]).value).toBe(0);
  });

  it('is null without cases', () => {
    expect(classifierAccuracy([]).value).toBeNull();
  });
});

describe('classifierRanking', () => {
  const result = (
    expectedArea: string,
    expectedRelevance: number,
    area: string,
    relevance: number,
  ) => ({
    expected: { area: expectedArea, relevance: expectedRelevance },
    actual: { area, relevance },
  });

  it('gates on relevance within one point and reports area and rank correlation', () => {
    const measurement = classifierRanking([
      result('Platform', 3, 'Platform', 2),
      result('Platform', 2, 'AI', 2),
      result('AI', 0, 'AI', 1.5),
      result('AI', 1, 'AI', 1),
    ]);
    expect(measurement.value).toBe(0.75);
    expect(measurement.detail?.area).toBe(0.75);
    expect(measurement.detail?.relevanceWithinOne).toBe(0.75);
    expect(measurement.detail?.spearman).toBeGreaterThan(0);
  });

  it('compares areas ignoring case and padding', () => {
    expect(classifierRanking([result('Platform', 2, '  platform ', 2)]).detail?.area).toBe(1);
  });

  it('counts a distance of exactly one point as within one', () => {
    const measurement = classifierRanking([result('A', 2, 'A', 1), result('A', 0.5, 'A', 1.5)]);
    expect(measurement.value).toBe(1);
    expect(classifierRanking([result('A', 2, 'A', 0.9)]).value).toBe(0);
  });

  it('is null without cases', () => {
    expect(classifierRanking([]).value).toBeNull();
  });

  describe('Spearman rank correlation', () => {
    const rho = (pairs: [number, number][]): number | undefined =>
      classifierRanking(pairs.map(([e, a]) => result('A', e, 'A', a))).detail?.spearman;

    it('is 1 for the same order and -1 for the reverse order', () => {
      expect(
        rho([
          [0, 0.2],
          [1, 1.1],
          [2, 2.5],
          [3, 2.9],
        ]),
      ).toBeCloseTo(1);
      expect(
        rho([
          [0, 3],
          [1, 2],
          [2, 1],
          [3, 0],
        ]),
      ).toBeCloseTo(-1);
    });

    it('gives tied values their average rank', () => {
      // labels 0,0,1,1 vs predictions 0,1,1,1: hand-computed rho = 0.57735...
      expect(
        rho([
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 1],
        ]),
      ).toBeCloseTo(Math.sqrt(1 / 3), 5);
    });

    it('is left out when one side has no spread', () => {
      expect(
        rho([
          [0, 1],
          [1, 1],
          [2, 1],
        ]),
      ).toBeUndefined();
      expect(rho([[1, 0]])).toBeUndefined();
    });
  });
});
