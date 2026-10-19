import { truncate } from '../../../src/shared/text';
import type { WeekDetail } from '../../schema';

/** How many problems a week keeps in the scorecard; the rest are only counted. */
export const MAX_PROBLEMS_PER_WEEK = 5;
/** A problem message is cut to this length: it can quote a URL a model wrote. */
export const MAX_PROBLEM_CHARS = 200;

/** The check's problems as a scorecard keeps them: the first few, each cut short. */
export function weekDetail(result: { ok: boolean; problems: readonly string[] }): WeekDetail {
  return {
    status: result.ok ? 'ok' : 'failed',
    problems: result.problems
      .slice(0, MAX_PROBLEMS_PER_WEEK)
      .map((problem) => truncate(problem, MAX_PROBLEM_CHARS)),
    problemCount: result.problems.length,
  };
}

/** The run produced nothing to check; `cause` says why when the replay's record tells. */
export const noDigest = (cause?: string): WeekDetail =>
  cause === undefined
    ? { status: 'no-digest', problems: [], problemCount: 0 }
    : { status: 'no-digest', problems: [truncate(cause, MAX_PROBLEM_CHARS)], problemCount: 1 };

/** `labels` with a repeat numbered, so two samples never share a line in `byWeek`. */
export function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const times = (seen.get(label) ?? 0) + 1;
    seen.set(label, times);
    return times === 1 ? label : `${label} (${times})`;
  });
}
