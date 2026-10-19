import { describe, expect, it } from 'vitest';
import * as bridge from './readiness';
import * as memory from './readiness/memory';

// `digest init` imports these two from `doctor/readiness` until W10-B23 repoints it.
describe('doctor/readiness bridge', () => {
  it('re-exports formatGiB and hasQualityMemory from the readiness folder', () => {
    expect(bridge.formatGiB).toBe(memory.formatGiB);
    expect(bridge.hasQualityMemory).toBe(memory.hasQualityMemory);
  });

  it('exports nothing else', () => {
    expect(Object.keys(bridge).sort()).toEqual(['formatGiB', 'hasQualityMemory']);
  });
});
