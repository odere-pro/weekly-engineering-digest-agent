import { describe, expect, it } from 'vitest';
import { DEFAULTS, SEPARABLE, classified } from '../__fixtures__/records';
import type { ClassifierRecord } from '../capture/schemas';
import { KEEP_MIN_LABEL, filterOutcome, filterSamples, sweepFilter } from './filter';

describe('filterSamples', () => {
  it('marks a case to keep when its label is relevance 2 or 3', () => {
    expect(KEEP_MIN_LABEL).toBe(2);
    const samples = filterSamples([
      classified(3, 2, 0, 0),
      classified(2, 2, 0, 0),
      classified(1, 2, 0, 0),
      classified(0, 2, 0, 0),
    ]);
    expect(samples.map((s) => s.shouldKeep)).toEqual([true, true, false, false]);
  });

  it('leaves out cases whose classification failed', () => {
    const failed: ClassifierRecord = { ...classified(3, 3, 0, 0), result: { error: 'timeout' } };
    expect(filterSamples([failed, classified(3, 3, 0, 0)])).toHaveLength(1);
  });
});

describe('filterOutcome', () => {
  const samples = filterSamples(SEPARABLE);

  it('counts what the thresholds keep and drop, and what they get wrong', () => {
    expect(filterOutcome(samples, DEFAULTS)).toEqual({
      accuracy: 1,
      kept: 2,
      dropped: 3,
      wronglyKept: 0,
      wronglyDropped: 0,
    });
    // Open thresholds keep everything: the three labelled 0 or 1 are kept wrongly.
    const open = { minRelevance: 0, maxHype: 1, maxMinorRelease: 1 };
    expect(filterOutcome(samples, open)).toEqual({
      accuracy: 0.4,
      kept: 5,
      dropped: 0,
      wronglyKept: 3,
      wronglyDropped: 0,
    });
    // Closed thresholds drop everything: the two labelled 2 or 3 are dropped wrongly.
    const closed = { minRelevance: 3, maxHype: 0, maxMinorRelease: 0 };
    expect(filterOutcome(samples, closed)).toMatchObject({ kept: 0, wronglyDropped: 2 });
  });

  it('has no accuracy without cases', () => {
    expect(filterOutcome([], DEFAULTS)).toEqual({
      accuracy: null,
      kept: 0,
      dropped: 0,
      wronglyKept: 0,
      wronglyDropped: 0,
    });
  });
});

describe('sweepFilter', () => {
  it('keeps the current thresholds when they classify every case and sit inside the best range', () => {
    const sweep = sweepFilter(SEPARABLE, DEFAULTS);
    expect(sweep.chosen).toEqual(DEFAULTS);
    expect(sweep.cases).toBe(5);
  });

  it('moves a threshold only as far as the labels require', () => {
    // The relevance-1 case now scores 1.9, so minRelevance must be above 1.9 and at most 2.0.
    const records = SEPARABLE.map((r, i) => (i === 2 ? classified(1, 1.9, 0.1, 0.1) : r));
    expect(sweepFilter(records, DEFAULTS).chosen).toEqual({ ...DEFAULTS, minRelevance: 1.95 });
  });

  it('prefers a value with a margin over one at the edge of the best range', () => {
    // 2.0 classifies every case but is the last such value; 1.9 keeps two steps of margin.
    expect(sweepFilter(SEPARABLE, { ...DEFAULTS, minRelevance: 2 }).chosen.minRelevance).toBe(1.9);
  });

  it('reports the accuracy curve of each threshold with the others at the chosen values', () => {
    const sweep = sweepFilter(SEPARABLE, DEFAULTS);
    expect(sweep.curves.minRelevance).toHaveLength(61);
    expect(sweep.curves.maxHype.find((p) => p.value === 0.9)?.accuracy).toBe(0.8);
    expect(sweep.curves.maxMinorRelease.find((p) => p.value === 0.5)?.accuracy).toBe(1);
  });

  it('scores the thresholds in use and the proposed ones on the same cases', () => {
    const sweep = sweepFilter(SEPARABLE, { ...DEFAULTS, minRelevance: 3 });
    expect(sweep.baseline.accuracy).toBe(0.6);
    expect(sweep.proposed.accuracy).toBe(1);
  });

  it('leaves out cases whose classification failed and counts them', () => {
    const failed: ClassifierRecord = {
      ...SEPARABLE[0]!,
      itemId: 'x',
      result: { error: 'timeout' },
    };
    const sweep = sweepFilter([...SEPARABLE, failed], DEFAULTS);
    expect(sweep.cases).toBe(5);
    expect(sweep.failed).toBe(1);
  });
});
