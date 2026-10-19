import { describe, expect, it } from 'vitest';
import { runTime } from './runTime';

describe('runTime', () => {
  it('is the mean time per week and keeps the total', () => {
    const result = runTime([1000, 3000]);
    expect(result.value).toBe(2000);
    expect(result.detail).toEqual({ totalMs: 4000 });
    expect(runTime([]).value).toBeNull();
  });
});
