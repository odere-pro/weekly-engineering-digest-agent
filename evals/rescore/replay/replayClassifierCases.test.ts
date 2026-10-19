import { describe, expect, it } from 'vitest';
import type { Calibration } from '../../../src/process/calibration';
import { AREA, cases, deps, model } from '../__fixtures__/rescoreKit';
import { replayClassifierCases } from './replayClassifierCases';

describe('replayClassifierCases', () => {
  it('is null for no case and calls no model', async () => {
    const fake = model();

    const accuracy = await replayClassifierCases([], deps(fake), false);

    expect(accuracy).toBeNull();
    expect(fake.decideCalls).toHaveLength(0);
  });

  it('is the share with the right area and relevance', async () => {
    // The decider says "2, AI models" for both cases: neither expectation (3 / other) holds.
    expect(await replayClassifierCases(cases().classifier.cases, deps(model()), false)).toBe(0);
  });

  it('with the flag on lets the writer rescore the shortlist before it counts', async () => {
    const fake = model();

    const accuracy = await replayClassifierCases(cases().classifier.cases, deps(fake), true);

    // The writer gives k1 a 3 in the AI area and k2 a 0 in other: both right.
    expect(accuracy).toBe(1);
    expect(fake.generateCalls.length).toBeGreaterThan(0);
  });

  it('counts the calibrated relevance when a file is given', async () => {
    const calibration: Calibration = {
      version: 1,
      profile: 'light',
      points: [{ raw: 2, calibrated: 3 }],
      areaBias: {},
    };
    const [k1] = cases().classifier.cases;

    const accuracy = await replayClassifierCases([k1!], { ...deps(model()), calibration }, false);

    // k1 expects (AREA, 3): raw 2 maps to 3 and the area matches.
    expect(k1?.expected).toEqual({ area: AREA, relevance: 3 });
    expect(accuracy).toBe(1);
  });
});
