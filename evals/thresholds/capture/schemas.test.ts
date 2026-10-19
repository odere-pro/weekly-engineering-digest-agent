import { describe, expect, it } from 'vitest';
import { ATTACKS, CLEAN, CLEAN_DRAFTS, rawCapture } from '../__fixtures__/records';
import { RawCaptureSchema, failedCalls, isFailed, totalFailed } from './schemas';

describe('RawCaptureSchema', () => {
  it('accepts a capture and gives it back unchanged', () => {
    const raw = rawCapture();
    expect(RawCaptureSchema.parse(raw)).toEqual(raw);
  });

  it('accepts a failed call in place of an answer', () => {
    const raw = rawCapture({
      classifier: [
        {
          itemId: 'a',
          expected: { area: 'x', relevance: 2 },
          result: { error: 'model timed out' },
        },
      ],
    });
    expect(RawCaptureSchema.safeParse(raw).success).toBe(true);
  });

  it('rejects a relevance above 3 and a probability above 1', () => {
    const base = rawCapture();
    const tooRelevant = {
      ...base,
      classifier: [
        {
          itemId: 'a',
          expected: { area: 'x', relevance: 2 },
          result: { relevance: 3.5, area: 'x', areaConfidence: 0.5, hype: 0, minorRelease: 0 },
        },
      ],
    };
    const tooLikely = {
      ...base,
      outputGuards: [{ caseId: 'g', draft: 'planted', clefRubric: { probability: 1.5 } }],
    };
    expect(RawCaptureSchema.safeParse(tooRelevant).success).toBe(false);
    expect(RawCaptureSchema.safeParse(tooLikely).success).toBe(false);
  });

  it('rejects an empty error message, a bad week id and a date without an offset', () => {
    const base = rawCapture();
    expect(
      RawCaptureSchema.safeParse({
        ...base,
        classifier: [{ itemId: 'a', expected: { area: 'x', relevance: 1 }, result: { error: '' } }],
      }).success,
    ).toBe(false);
    expect(
      RawCaptureSchema.safeParse({
        ...base,
        weekItems: [{ itemId: 'a', weekId: 'last-week', label: null, result: { error: 'x' } }],
      }).success,
    ).toBe(false);
    expect(RawCaptureSchema.safeParse({ ...base, capturedAt: '2026-10-17T10:00:00' }).success).toBe(
      false,
    );
  });
});

describe('isFailed', () => {
  it('is true for a message and false for an answer', () => {
    expect(isFailed({ error: 'x' })).toBe(true);
    expect(isFailed({ probability: 0.5 })).toBe(false);
  });
});

describe('failedCalls and totalFailed', () => {
  it('counts a failed call under its phase', () => {
    const failed = { error: 'timeout' };
    const raw = rawCapture({
      classifier: [
        { itemId: 'a', expected: { area: 'x', relevance: 1 }, result: failed },
        ...rawCapture().classifier,
      ],
      weekItems: [{ itemId: 'w', weekId: '2026-W40', label: null, result: failed }],
      inputGuards: [
        { ...CLEAN[0]!, clefPolicy: failed },
        { ...CLEAN[1]!, graniteRisk: failed },
        { ...ATTACKS[0]!, graniteRisk: failed },
      ],
      outputGuards: [{ ...CLEAN_DRAFTS[0]!, clefRubric: failed }],
    });
    expect(failedCalls(raw)).toEqual({
      classifier: 1,
      weekItems: 1,
      clefPolicy: 1,
      graniteRisk: 2,
      clefRubric: 1,
    });
    expect(totalFailed(raw)).toBe(6);
  });

  it('is zero for a capture where every call answered', () => {
    expect(totalFailed(rawCapture())).toBe(0);
  });
});
