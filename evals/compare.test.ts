import { describe, expect, it } from 'vitest';
import { compareScorecards, parseScorecard } from './compare';
import { assembleMetrics, failedHardGates, type Measurement } from './metrics';
import { METRIC_IDS, type MetricId } from './schema';
import type { SavedScorecard } from './checkpointSections';
import { DigestError } from '../src/shared/errors';

function card(
  overrides: Partial<Record<MetricId, Measurement>> = {},
  byWeek: Record<string, 'ok' | 'failed'> = {},
): SavedScorecard {
  const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;
  const withWeeks: Partial<Record<MetricId, Measurement>> = {
    format: {
      value: 1,
      byWeek: Object.fromEntries(
        Object.entries(byWeek).map(([week, status]) => [
          week,
          { status, problems: [], problemCount: status === 'ok' ? 0 : 1 },
        ]),
      ),
    },
  };
  const metrics = assembleMetrics({ ...base, ...withWeeks, ...overrides }, 0.9);
  return {
    profile: 'light',
    date: '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40'],
    counts: { weeks: 1, classifier: 1, attacks: 1, grounding: 1 },
    judgeAgreement: 0.9,
    models: {},
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    timings: { totalMs: 1, byWeekMs: {} },
  };
}

describe('compareScorecards', () => {
  it('has a row for every metric with both values and the delta', () => {
    const result = compareScorecards(
      card({ classifierAccuracy: { value: 0.7 } }),
      card({ classifierAccuracy: { value: 0.85 } }),
    );
    expect(result.metrics.map((m) => m.id)).toEqual([...METRIC_IDS]);
    const row = result.metrics.find((m) => m.id === 'classifierAccuracy');
    expect(row?.before.value).toBe(0.7);
    expect(row?.after.value).toBe(0.85);
    expect(row?.delta).toBeCloseTo(0.15);
  });

  it('has no delta when either side was not measured', () => {
    const result = compareScorecards(card({ stability: { value: null } }), card());
    expect(result.metrics.find((m) => m.id === 'stability')?.delta).toBeNull();
  });

  it('lists only the weeks whose status changed', () => {
    const before = card({}, { '2026-W40': 'ok', '2026-W41': 'failed', '2026-W42': 'ok' });
    const after = card({}, { '2026-W40': 'ok', '2026-W41': 'ok', '2026-W43': 'ok' });
    const changes = compareScorecards(before, after).weekChanges.map((c) => [
      c.week,
      c.before,
      c.after,
    ]);
    expect(changes).toEqual([
      ['2026-W41', 'failed', 'ok'],
      ['2026-W42', 'ok', 'absent'],
      ['2026-W43', 'absent', 'ok'],
    ]);
  });
});

describe('compareScorecards with a partial scorecard', () => {
  it('lists no week change for a metric one side did not run', () => {
    const before = card({ format: { value: null } }, {});
    const after = card({}, { '2026-W40': 'ok' });
    expect(compareScorecards(before, after).weekChanges).toEqual([]);
  });
});

describe('parseScorecard', () => {
  it('reads a partial scorecard', () => {
    const text = JSON.stringify({ ...card(), partial: ['guards'] });
    expect(parseScorecard('a.json', text).partial).toEqual(['guards']);
  });

  it('names the file when it is not JSON or not a scorecard', () => {
    expect(() => parseScorecard('a.json', 'nope')).toThrow(DigestError);
    expect(() => parseScorecard('b.json', '{"profile":"light"}')).toThrow(
      /b\.json is not a scorecard/,
    );
  });
});
