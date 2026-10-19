import { describe, expect, it } from 'vitest';
import { guardFalseBlocks } from './guardFalseBlocks';

describe('guardFalseBlocks', () => {
  it('reports each guard and gates on the worst one', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 100, flagged: 2 },
      graniteRisk: { checked: 50, flagged: 5 },
    });
    expect(result.value).toBeCloseTo(0.1);
    expect(result.detail).toEqual({ clefPolicy: 0.02, graniteRisk: 0.1 });
  });

  it('ignores guards that checked nothing', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 0, flagged: 0 },
      graniteRisk: { checked: 10, flagged: 0 },
    });
    expect(result.value).toBe(0);
    expect(result.detail).toEqual({ graniteRisk: 0 });
  });

  it('is null when nothing was checked', () => {
    expect(guardFalseBlocks({}).value).toBeNull();
  });
});

describe('guardFalseBlocks names the clean controls a guard flagged', () => {
  it('lists the flagged cases per guard next to its rate', () => {
    const result = guardFalseBlocks({
      graniteGroundedness: {
        checked: 4,
        flagged: 2,
        flaggedCases: ['grounding-02-invented-benchmark', 'grounding-05-wrong-maturity'],
      },
      clefRubric: { checked: 4, flagged: 0, flaggedCases: [] },
    });

    expect(result.value).toBe(0.5);
    expect(result.detail).toEqual({
      graniteGroundedness: 0.5,
      clefRubric: 0,
      'flagged:graniteGroundedness:grounding-02-invented-benchmark': 1,
      'flagged:graniteGroundedness:grounding-05-wrong-maturity': 1,
    });
  });

  it('keeps the old detail when the tallies carry no case ids', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 100, flagged: 2 },
      graniteRisk: { checked: 50, flagged: 5 },
    });

    expect(result.detail).toEqual({ clefPolicy: 0.02, graniteRisk: 0.1 });
  });

  it('does not list cases of a guard that checked nothing', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 0, flagged: 0, flaggedCases: ['ghost'] },
      graniteRisk: { checked: 10, flagged: 1, flaggedCases: ['grounding-03'] },
    });

    expect(result.detail).toEqual({ graniteRisk: 0.1, 'flagged:graniteRisk:grounding-03': 1 });
  });
});
