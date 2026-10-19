// A scorecard every metric of which passes, with overrides, for the tests of the eval command.
import { assembleMetrics, failedHardGates } from '../../../../evals/metrics';
import type { Measurement } from '../../../../evals/metrics/measurement/measurement';
import { METRIC_IDS, type MetricId, type Scorecard } from '../../../../evals/schema';
import type { ProfileName } from '../../../config/schema';

export function makeScorecard(
  profile: ProfileName,
  overrides: Partial<Record<MetricId, Measurement>> = {},
  judgeAgreement: number | null = 0.9,
): Scorecard {
  const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;
  const metrics = assembleMetrics({ ...base, ...overrides }, judgeAgreement);
  return {
    profile,
    date: '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40', '2026-W41'],
    counts: { weeks: 2, classifier: 60, attacks: 10, grounding: 10 },
    judgeAgreement,
    models: { classify: 'clef:latest', judge: null },
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    timings: { totalMs: 12_345, byWeekMs: { '2026-W40': 6000, '2026-W41': 6345 } },
  };
}
