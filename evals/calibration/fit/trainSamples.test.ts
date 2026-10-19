import { describe, expect, it } from 'vitest';
import { rawCapture } from '../__fixtures__/calibrationKit';
import { trainSamples } from './trainSamples';

describe('trainSamples', () => {
  it('uses only train records, skips failed calls and unlabeled week items', () => {
    const samples = trainSamples(rawCapture(), { holdoutWeeks: ['2026-W40'], caseStride: 3 });
    // cases: c2 and c5 are held out; c4 failed; so c0, c1, c3 remain. Week W36: 2 labeled items.
    expect(samples).toHaveLength(3 + 2);
    expect(samples.filter((s) => s.target === 3 || s.target === 0)).toHaveLength(4);
  });

  it('takes the case label as the target and 3 or 0 for a labeled week item', () => {
    const samples = trainSamples(rawCapture(), { holdoutWeeks: ['2026-W40'], caseStride: 3 });

    expect(samples).toEqual([
      { raw: 1, area: 'a', target: 0 }, // c0
      { raw: 1.5, area: 'a', target: 1 }, // c1
      { raw: 2.5, area: 'a', target: 3 }, // c3
      { raw: 2, area: 'a', target: 3 }, // y1, must include
      { raw: 1, area: 'a', target: 0 }, // y2, must exclude
    ]);
  });

  it('leaves the held-out week out of the samples', () => {
    const all = trainSamples(rawCapture(), { holdoutWeeks: [], caseStride: 0 });
    const train = trainSamples(rawCapture(), { holdoutWeeks: ['2026-W40'], caseStride: 0 });

    // x1 and x2 are labeled week items: held out of the train side, in the all-train side.
    expect(all.length - train.length).toBe(2);
  });
});
