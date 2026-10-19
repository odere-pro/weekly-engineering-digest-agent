import { describe, expect, it } from 'vitest';
import { failedThreshold, passesThresholds, THRESHOLD_REASONS } from './thresholds';
import { ThresholdsSchema } from '../../config/schema';

const limits = ThresholdsSchema.parse({});
const clean = { relevance: 3, hype: 0, minorRelease: 0 };

describe('passesThresholds', () => {
  it('keeps an item that is relevant, calm and not a minor release', () => {
    expect(passesThresholds(clean, limits)).toBe(true);
  });

  it('keeps an item that sits exactly on every threshold', () => {
    const onTheLine = {
      relevance: limits.minRelevance,
      hype: limits.maxHype,
      minorRelease: limits.maxMinorRelease,
    };

    expect(passesThresholds(onTheLine, limits)).toBe(true);
  });

  it.each([
    ['relevance just below minRelevance', { relevance: limits.minRelevance - 0.01 }],
    ['hype just above maxHype', { hype: limits.maxHype + 0.01 }],
    ['minorRelease just above maxMinorRelease', { minorRelease: limits.maxMinorRelease + 0.01 }],
  ])('drops an item with %s', (_name, scores) => {
    expect(passesThresholds({ ...clean, ...scores }, limits)).toBe(false);
  });

  it('reads the limits it is given, not built-in numbers', () => {
    const strict = { minRelevance: 2.9, maxHype: 0.05, maxMinorRelease: 0.05 };
    const lax = { minRelevance: 0, maxHype: 1, maxMinorRelease: 1 };
    const middling = { relevance: 2, hype: 0.5, minorRelease: 0.5 };

    expect(passesThresholds(middling, strict)).toBe(false);
    expect(passesThresholds(middling, lax)).toBe(true);
  });

  it('accepts a whole Classification and ignores its other fields', () => {
    const classification = {
      itemId: 'a',
      area: 'AI',
      areaConfidence: 0.1,
      ...clean,
    };

    expect(passesThresholds(classification, limits)).toBe(true);
  });

  it('does not mutate its arguments', () => {
    const scores = Object.freeze({ ...clean });
    const frozen = Object.freeze({ ...limits });

    expect(() => passesThresholds(scores, frozen)).not.toThrow();
  });
});

describe('failedThreshold', () => {
  it('names the rule an item breaks', () => {
    expect(failedThreshold({ ...clean, relevance: 0 }, limits)).toBe('low-relevance');
    expect(failedThreshold({ ...clean, hype: 1 }, limits)).toBe('hype');
    expect(failedThreshold({ ...clean, minorRelease: 1 }, limits)).toBe('minor-release');
  });

  it('names the first rule in contract order when an item breaks several', () => {
    expect(failedThreshold({ relevance: 0, hype: 1, minorRelease: 1 }, limits)).toBe(
      'low-relevance',
    );
    expect(failedThreshold({ relevance: 3, hype: 1, minorRelease: 1 }, limits)).toBe('hype');
  });

  it('returns nothing for an item that passes', () => {
    expect(failedThreshold(clean, limits)).toBeUndefined();
  });

  it('passes exactly the scores the plain comparisons keep, on a grid', () => {
    const levels = [0, 0.5, 1.5, 2, 3];
    const probabilities = [0, 0.3, 0.6, 0.75, 0.9, 1];

    for (const relevance of levels) {
      for (const hype of probabilities) {
        for (const minorRelease of probabilities) {
          const scores = { relevance, hype, minorRelease };
          const kept =
            relevance >= limits.minRelevance &&
            hype <= limits.maxHype &&
            minorRelease <= limits.maxMinorRelease;

          expect(passesThresholds(scores, limits)).toBe(kept);
          expect(failedThreshold(scores, limits) === undefined).toBe(kept);
        }
      }
    }
  });
});

describe('THRESHOLD_REASONS', () => {
  it('lists the drop reasons in the order the contract applies them', () => {
    expect(THRESHOLD_REASONS).toEqual(['low-relevance', 'hype', 'minor-release']);
  });
});
