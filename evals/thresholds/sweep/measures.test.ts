import { describe, expect, it } from 'vitest';
import { GATES } from '../../metrics';
import {
  EPSILON,
  MAX_FALSE_BLOCK_RATE,
  MIN_CLASSIFIER_ACCURACY,
  gateThreshold,
  share,
} from './measures';

describe('share', () => {
  it('is count over total', () => {
    expect(share(1, 4)).toBe(0.25);
    expect(share(0, 3)).toBe(0);
  });

  it('is null, not NaN, without cases', () => {
    expect(share(0, 0)).toBeNull();
  });
});

describe('the gates the proposed thresholds are judged by', () => {
  it('read the false-block budget and the classifier floor from GATES', () => {
    expect(GATES.guardFalseBlocks).toMatchObject({
      direction: 'atMost',
      threshold: MAX_FALSE_BLOCK_RATE,
    });
    expect(GATES.classifierAccuracy).toMatchObject({
      direction: 'atLeast',
      threshold: MIN_CLASSIFIER_ACCURACY,
    });
    expect(MAX_FALSE_BLOCK_RATE).toBe(0.05);
    expect(MIN_CLASSIFIER_ACCURACY).toBe(0.8);
  });

  it('use a tolerance far below the 0.05 grid step', () => {
    expect(EPSILON).toBeLessThan(1e-6);
    expect(EPSILON).toBeGreaterThan(0);
  });
});

describe('gateThreshold', () => {
  it('reads the threshold of a gated metric', () => {
    expect(gateThreshold(GATES.stability)).toBe(4);
  });

  it('refuses a metric without a gate', () => {
    expect(() => gateThreshold(GATES.runTime)).toThrow('expected a gated metric');
  });
});
