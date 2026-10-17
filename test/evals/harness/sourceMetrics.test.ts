import { describe, expect, it } from 'vitest';
import { GATES, assembleMetrics, sourceParse, sourceSummaryFill } from '../../../evals/metrics.js';
import { METRIC_IDS, ScorecardSchema } from '../../../evals/schema.js';
import type { SourceResult } from '../../../evals/sourceEval.js';

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
  it('is null when no source was recorded', () => {
    expect(sourceParse([])).toEqual({ value: null });
  });

  it('is items parsed over items expected, with a ratio per source', () => {
    const m = sourceParse([result('a'), result('b', { parsed: 5 })]);

    expect(m.value).toBeCloseTo(15 / 20);
    expect(m.detail).toEqual({ a: 1, b: 0.5 });
  });

  it('caps a source that yields more than expected at 1', () => {
    expect(sourceParse([result('a', { parsed: 12 })]).detail).toEqual({ a: 1 });
  });

  it('leaves a source that expects nothing out of the ratios', () => {
    const m = sourceParse([result('a'), result('empty', { parsed: 0, expected: 0 })]);

    expect(m.value).toBe(1);
    expect(m.detail).toEqual({ a: 1 });
  });

  it('names the sources below the gate in the note', () => {
    const m = sourceParse([result('a'), result('b', { parsed: 5 })]);

    expect(m.note).toMatch(/b/);
    expect(m.note).not.toMatch(/\ba\b/);
  });
});

describe('sourceParse with a failing fetcher', () => {
  it('names the source whose fetcher threw', () => {
    const m = sourceParse([result('a'), result('b', { parsed: 0, error: 'boom' })]);

    expect(m.note).toMatch(/fetcher failed: b/);
    expect(m.detail).toMatchObject({ b: 0 });
  });
});

describe('sourceSummaryFill', () => {
  it('is null when nothing was parsed', () => {
    expect(sourceSummaryFill([result('a', { parsed: 0 })])).toEqual({ value: null });
  });

  it('is items with a summary over items parsed, per source in detail', () => {
    const m = sourceSummaryFill([result('a'), result('b', { emptySummary: 10 })]);

    expect(m.value).toBeCloseTo(10 / 20);
    expect(m.detail).toEqual({ a: 1, b: 0 });
    expect(m.note).toMatch(/b/);
  });

  it('keeps only numbers in detail', () => {
    const m = sourceSummaryFill([result('a', { emptySummary: 3 })]);

    expect(Object.values(m.detail ?? {}).every((v) => typeof v === 'number')).toBe(true);
  });
});

describe('gates', () => {
  it('are soft: 0.95 for parse, 0.9 for summary fill', () => {
    expect(GATES.sourceParse).toMatchObject({
      kind: 'soft',
      direction: 'atLeast',
      threshold: 0.95,
    });
    expect(GATES.sourceSummaryFill).toMatchObject({
      kind: 'soft',
      direction: 'atLeast',
      threshold: 0.9,
    });
  });

  it('turn a low value into a failed soft gate that does not fail the run', () => {
    const measurements = Object.fromEntries(
      METRIC_IDS.map((id) => [id, { value: 1 }]),
    ) as Parameters<typeof assembleMetrics>[0];
    const metrics = assembleMetrics(
      { ...measurements, sourceSummaryFill: { value: 0.5, detail: { a: 0.5 } } },
      null,
    );

    expect(metrics.sourceSummaryFill).toMatchObject({ pass: false, detail: { a: 0.5 } });
    expect(metrics.sourceParse.pass).toBe(true);
  });
});

describe('scorecards written before the source metrics', () => {
  const metric = (id: string): [string, unknown] => [
    id,
    { id, label: id, unit: 'ratio', value: 1, gate: { kind: 'none' }, pass: null },
  ];
  const older = {
    profile: 'light',
    date: '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40'],
    counts: { weeks: 1, classifier: 0, attacks: 0, grounding: 0 },
    judgeAgreement: null,
    models: {},
    metrics: Object.fromEntries(
      METRIC_IDS.filter((id) => !id.startsWith('source')).map((id) => metric(id)),
    ),
    hardGatesPassed: true,
    timings: { totalMs: 10, byWeekMs: {} },
  };

  it('parse, with the source metrics marked as not recorded and no sources count', () => {
    const card = ScorecardSchema.parse(older);

    expect(card.counts.sources).toBeUndefined();
    expect(card.metrics.sourceParse).toMatchObject({ value: null, pass: null });
    expect(card.metrics.sourceSummaryFill).toMatchObject({ value: null, pass: null });
  });

  it('keep a sources count they carry', () => {
    const card = ScorecardSchema.parse({ ...older, counts: { ...older.counts, sources: 24 } });

    expect(card.counts.sources).toBe(24);
  });
});
