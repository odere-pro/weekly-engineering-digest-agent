// The "Week problems" block of the scorecard: format and link validity, week by week.
import type { MetricResult, WeekDetail } from '../../../../evals/schema';
import { oneLine, plural } from './printable';

export const MAX_PROBLEMS_SHOWN = 3;

function weekStatus({ status, problemCount }: WeekDetail): string {
  if (status === 'no-digest') return 'no digest';
  return problemCount > 0 ? `${status}, ${plural(problemCount, 'problem')}` : status;
}

/** What the first problems leave out: the file keeps up to `stored` of `total`, no more. */
function moreLines(detail: WeekDetail, shownCount: number): string[] {
  const stored = detail.problems.length;
  const total = Math.max(detail.problemCount, stored);
  const more = total - shownCount;
  if (more <= 0) return [];
  return [
    stored < total
      ? `    ... ${more} more (the scorecard file lists the first ${stored} of ${total})`
      : `    ... ${more} more in the scorecard file`,
  ];
}

/** One week that did not pass: its status, then the first few problems. */
function weekLines(metric: MetricResult, label: string, detail: WeekDetail): string[] {
  const shown = detail.problems.slice(0, MAX_PROBLEMS_SHOWN);
  return [
    `  ${metric.label} ${label}: ${weekStatus(detail)}`,
    ...shown.map((problem) => `    - ${oneLine(problem)}`),
    ...moreLines(detail, shown.length),
  ];
}

/** Format and link validity: the weeks that failed or produced nothing; weeks that passed are left out. */
export function weekProblemLines(metrics: readonly MetricResult[]): string[] {
  return metrics.flatMap((metric) =>
    Object.entries(metric.byWeek ?? {})
      .filter(([, detail]) => detail.status !== 'ok')
      .flatMap(([label, detail]) => weekLines(metric, label, detail)),
  );
}
