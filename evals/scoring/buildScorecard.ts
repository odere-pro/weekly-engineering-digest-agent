import { modelsByRole } from '../../src/config/profiles';
import {
  notRun,
  SECTION_METRICS,
  type EvalSection,
  type SavedScorecard,
} from '../checkpointSections';
import { assembleMetrics, failedHardGates } from '../metrics';
import type { MetricId, MetricResult } from '../schema';
import { calibrationFor, measure } from './measure';
import type { Scoring } from './types';

/** On a partial run, every metric outside the section is "not run": no value, no gate result. */
export function withSectionOnly(
  metrics: Record<MetricId, MetricResult>,
  only: EvalSection | undefined,
): Record<MetricId, MetricResult> {
  if (only === undefined) return metrics;
  const measured = new Set<MetricId>(SECTION_METRICS[only]);
  return Object.fromEntries(
    Object.entries(metrics).map(([id, metric]) => [
      id,
      measured.has(metric.id) ? metric : notRun(metric, only),
    ]),
  ) as Record<MetricId, MetricResult>;
}

/** The scorecard of one eval run: counts, models, metrics with their gates, and timings. */
export function buildScorecard(scoring: Scoring): SavedScorecard {
  const { profile, only, cases, run, app, startMs, endMs } = scoring;
  const judgeAgreement = calibrationFor(scoring)?.judgeAgreement ?? null;
  const metrics = withSectionOnly(assembleMetrics(measure(scoring), judgeAgreement), only);
  return {
    profile,
    date: new Date(startMs).toISOString(),
    weeks: cases.weeks.map((week) => week.weekId),
    counts: {
      weeks: cases.weeks.length,
      classifier: cases.classifier.cases.length,
      attacks: cases.attacks.length,
      grounding: cases.grounding.length,
      sources: cases.sources.length,
    },
    judgeAgreement,
    models: {
      ...modelsByRole(app.profile),
      ...(run.judged ? { evalJudge: run.judged.model } : {}),
    },
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    ...(only === undefined ? {} : { partial: [only] }),
    timings: {
      totalMs: Math.max(0, endMs - startMs),
      byWeekMs: Object.fromEntries(
        run.weekRuns.map(({ week, run: r }) => [week.weekId, r.durationMs]),
      ),
    },
  };
}
