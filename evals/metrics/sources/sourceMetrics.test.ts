import { describe, expect, it } from 'vitest';
import {
  SOURCE_PARSE_MIN,
  SOURCE_SUMMARY_FILL_MIN,
  sourceParse,
  sourceSummaryFill,
} from './sourceMetrics';
import type { SourceResult } from '../../sourceConformance/conformance/types';

function result(sourceId: string, overrides: Partial<SourceResult> = {}): SourceResult {
  return {
    sourceId,
    parsed: 10,
    expected: 10,
    schemaInvalid: 0,
    emptyTitle: 0,
    emptySummary: 0,
    badDate: 0,
    idMismatch: 0,
    hostOutsideAllowlist: 0,
    ...overrides,
  };
}

describe('sourceParse', () => {
  it('pools the sources and shows each one as a ratio', () => {
    const m = sourceParse([result('a'), result('b', { parsed: 5 })]);

    expect(m.value).toBeCloseTo(15 / 20);
    expect(m.detail).toEqual({ a: 1, b: 0.5 });
  });

  it('is null when no source expects anything', () => {
    expect(sourceParse([])).toEqual({ value: null });
    expect(sourceParse([result('a', { parsed: 0, expected: 0 })])).toEqual({ value: null });
  });

  it('caps the pooled value at 1 when a source yields more than expected', () => {
    expect(sourceParse([result('a', { parsed: 12 })]).value).toBe(1);
  });

  it('puts the sources below the threshold in the note', () => {
    const m = sourceParse([result('a'), result('b', { parsed: 5 }), result('c', { parsed: 8 })]);

    expect(m.note).toBe('below the gate: b, c');
  });

  it('does not flag a source that sits exactly on the threshold', () => {
    const justEnough = Math.round(SOURCE_PARSE_MIN * 100);
    const m = sourceParse([result('a', { parsed: justEnough, expected: 100 })]);

    expect(m.note).toBeUndefined();
  });

  it('joins the failed-fetcher note to the below-the-gate note', () => {
    const m = sourceParse([result('a', { parsed: 0, error: 'boom' }), result('b')]);

    expect(m.note).toBe('below the gate: a; fetcher failed: a');
  });

  it('names a failed fetcher even when no source can be measured', () => {
    const m = sourceParse([result('a', { parsed: 0, expected: 0, error: 'boom' })]);

    expect(m).toEqual({ value: null, note: 'fetcher failed: a' });
  });
});

describe('sourceSummaryFill', () => {
  it('counts the parsed items that have a summary', () => {
    const m = sourceSummaryFill([result('a'), result('b', { emptySummary: 10 })]);

    expect(m.value).toBeCloseTo(10 / 20);
    expect(m.detail).toEqual({ a: 1, b: 0 });
    expect(m.note).toBe('below the gate: b');
  });

  it('leaves a source that parsed nothing out of the ratios', () => {
    const m = sourceSummaryFill([result('a'), result('empty', { parsed: 0 })]);

    expect(m.detail).toEqual({ a: 1 });
    expect(m.note).toBeUndefined();
  });

  it('is null when nothing was parsed', () => {
    expect(sourceSummaryFill([result('a', { parsed: 0 })])).toEqual({ value: null });
  });

  it('absorbs floating-point noise at the threshold', () => {
    const m = sourceSummaryFill([result('a', { emptySummary: 1 + 1e-12 })]);

    expect(m.detail?.a).toBeLessThan(SOURCE_SUMMARY_FILL_MIN);
    expect(m.note).toBeUndefined();
  });

  it('flags a source under the threshold, not one exactly on it', () => {
    const m = sourceSummaryFill([
      result('onIt', { emptySummary: 1 }),
      result('under', { emptySummary: 2 }),
    ]);

    expect(m.detail).toEqual({ onIt: SOURCE_SUMMARY_FILL_MIN, under: 0.8 });
    expect(m.note).toBe('below the gate: under');
  });
});

describe('the source thresholds', () => {
  it('have the spec values that GATES reads', () => {
    expect(SOURCE_PARSE_MIN).toBe(0.95);
    expect(SOURCE_SUMMARY_FILL_MIN).toBe(0.9);
  });
});
