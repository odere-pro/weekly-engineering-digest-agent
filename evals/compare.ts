// `digest eval --compare <a> <b>`: what changed between two saved scorecards, as data. The CLI
// prints it (src/cli/eval/compareText.ts).
import { z } from 'zod';
import { DigestError } from '../src/shared/errors';
import { SavedScorecardSchema, type SavedScorecard } from './checkpointSections';
import { METRIC_IDS, type MetricId, type MetricResult } from './schema';

export interface MetricComparison {
  id: MetricId;
  before: MetricResult;
  after: MetricResult;
  /** after - before in the metric's own unit; null when either side was not measured. */
  delta: number | null;
}

export interface WeekChange {
  metric: MetricResult;
  week: string;
  /** The week's status in each scorecard; "absent" when that scorecard has no row for it. */
  before: string;
  after: string;
}

export interface ScorecardComparison {
  before: SavedScorecard;
  after: SavedScorecard;
  metrics: MetricComparison[];
  weekChanges: WeekChange[];
}

const ABSENT = 'absent';

/** A saved scorecard from its JSON text; a DigestError that names the file when it is bad. */
export function parseScorecard(path: string, text: string): SavedScorecard {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DigestError(`${path} is not valid JSON`);
  }
  const parsed = SavedScorecardSchema.safeParse(json);
  if (!parsed.success) {
    throw new DigestError(`${path} is not a scorecard:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function deltaOf(before: MetricResult, after: MetricResult): number | null {
  return before.value === null || after.value === null ? null : after.value - before.value;
}

function weekChangesOf(before: MetricResult, after: MetricResult): WeekChange[] {
  const labels = [
    ...new Set([...Object.keys(before.byWeek ?? {}), ...Object.keys(after.byWeek ?? {})]),
  ];
  // A metric one side did not run has no week rows; that is not a change of any week.
  if (before.value === null || after.value === null) return [];
  return labels.sort().flatMap((week) => {
    const from = before.byWeek?.[week]?.status ?? ABSENT;
    const to = after.byWeek?.[week]?.status ?? ABSENT;
    return from === to ? [] : [{ metric: after, week, before: from, after: to }];
  });
}

/** Every metric with both values and the delta, then the per-week rows whose status changed. */
export function compareScorecards(
  before: SavedScorecard,
  after: SavedScorecard,
): ScorecardComparison {
  const pairs = METRIC_IDS.map((id) => ({
    id,
    before: before.metrics[id],
    after: after.metrics[id],
  }));
  return {
    before,
    after,
    metrics: pairs.map((pair) => ({ ...pair, delta: deltaOf(pair.before, pair.after) })),
    weekChanges: pairs.flatMap((pair) => weekChangesOf(pair.before, pair.after)),
  };
}
