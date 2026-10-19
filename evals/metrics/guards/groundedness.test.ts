import { describe, expect, it } from 'vitest';
import { groundedness } from './groundedness';

describe('groundedness', () => {
  it('is the share of planted claims the output guards caught', () => {
    const result = groundedness([
      { caseId: 'g1', caught: true, flaggedBy: ['graniteGroundedness'] },
      { caseId: 'g2', caught: true, flaggedBy: ['graniteGroundedness', 'clefRubric'] },
      { caseId: 'g3', caught: false, flaggedBy: [] },
    ]);
    expect(result.value).toBeCloseTo(2 / 3);
    expect(result.detail).toEqual({ graniteGroundedness: 2, clefRubric: 1 });
  });

  it('is null without cases', () => {
    expect(groundedness([]).value).toBeNull();
  });
});
