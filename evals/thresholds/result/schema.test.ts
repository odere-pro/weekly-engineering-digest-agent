import { describe, expect, it } from 'vitest';
import { rawCapture } from '../__fixtures__/records';
import { TuningResultSchema } from './schema';
import { tuneThresholds } from './tune';

describe('TuningResultSchema', () => {
  const result = tuneThresholds(rawCapture());

  it('accepts what tuneThresholds makes', () => {
    expect(TuningResultSchema.parse(result)).toEqual(result);
  });

  it('accepts a result from before the train and holdout split', () => {
    const { split: _split, scores: _scores, ...old } = result;
    expect(TuningResultSchema.parse(old)).toEqual(old);
  });

  it('rejects a missing section', () => {
    const { acceptance: _acceptance, ...broken } = result;
    expect(TuningResultSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a rate outside 0 to 1 and a negative count', () => {
    const badRate = {
      ...result,
      classifier: { ...result.classifier, scorecard: { value: 1.5, area: 1, relevance: 1 } },
    };
    const badCount = { ...result, weeks: { ...result.weeks, failed: -1 } };
    expect(TuningResultSchema.safeParse(badRate).success).toBe(false);
    expect(TuningResultSchema.safeParse(badCount).success).toBe(false);
  });

  it('rejects a gap beyond a full swing and a time without an offset', () => {
    const badGap = {
      ...result,
      scores: { ...result.scores!, gap: { ...result.scores!.gap, filterAccuracy: 1.5 } },
    };
    expect(TuningResultSchema.safeParse(badGap).success).toBe(false);
    expect(
      TuningResultSchema.safeParse({ ...result, capturedAt: '2026-10-17T10:00:00' }).success,
    ).toBe(false);
  });
});
