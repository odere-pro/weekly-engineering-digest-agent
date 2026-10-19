// The text `digest eval --compare` prints: every metric with both values, the delta and the gate,
// then the per-week rows whose status changed.
import type { ScorecardComparison, WeekChange } from '../../../../evals/compare';
import type { MetricResult } from '../../../../evals/schema';
import { gateCell, resultCell, table, valueCell } from '../scorecardText/cells';

const PERCENT = 100;
const MS_PER_SECOND = 1000;
const DELTA_DECIMALS = 2;
const POINT_DECIMALS = 1;

function signed(text: string, value: number): string {
  return value > 0 ? `+${text}` : text;
}

function deltaCell(metric: MetricResult, delta: number | null): string {
  if (delta === null) return 'n/a';
  switch (metric.unit) {
    case 'ratio':
      return signed(`${(delta * PERCENT).toFixed(POINT_DECIMALS)} pt`, delta);
    case 'ms':
      return signed(`${(delta / MS_PER_SECOND).toFixed(POINT_DECIMALS)} s`, delta);
    default:
      return signed(delta.toFixed(DELTA_DECIMALS), delta);
  }
}

/** "PASS -> FAIL", or just the result when it did not change. */
function resultChange(before: MetricResult, after: MetricResult): string {
  const [from, to] = [resultCell(before), resultCell(after)];
  return from === to ? to : `${from} -> ${to}`;
}

function weekRows(changes: readonly WeekChange[]): string[] {
  return table([
    ['Metric', 'Week', 'Before', 'After'],
    ...changes.map((c) => [c.metric.label, c.week, c.before, c.after]),
  ]);
}

export function formatComparison(
  comparison: ScorecardComparison,
  files: { before: string; after: string },
): string {
  const { before, after } = comparison;
  const hasPartial = before.partial !== undefined || after.partial !== undefined;
  return [
    `Eval compare: A = ${files.before} (${before.profile}, ${before.date.slice(0, 10)})`,
    `              B = ${files.after} (${after.profile}, ${after.date.slice(0, 10)})`,
    ...(hasPartial ? ['A partial scorecard has "n/a" for the sections it did not run.'] : []),
    '',
    ...table([
      ['Metric', 'A', 'B', 'Delta', 'Gate (B)', 'Result A -> B'],
      ...comparison.metrics.map((m) => [
        m.after.label,
        valueCell(m.before),
        valueCell(m.after),
        deltaCell(m.after, m.delta),
        gateCell(m.after),
        resultChange(m.before, m.after),
      ]),
    ]),
    '',
    comparison.weekChanges.length === 0
      ? 'Weeks: no week changed status.'
      : ['Weeks that changed status:', ...weekRows(comparison.weekChanges)].join('\n'),
  ].join('\n');
}
