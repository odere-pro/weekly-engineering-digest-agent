import { DigestError } from '../../../src/shared/errors';
import type { GradingSheet } from '../gradingSheet';
import { judgePick } from './judgePick';
import type { CompleteDigest, Selection } from './types';

/**
 * For each week the maintainer picked in: their pick and the draft the judge scored highest among
 * that week's digests. A tie in the judge's scores is no pick, so it counts as a disagreement;
 * production breaks such a tie by writer order, which is kinder to the judge.
 */
export function selections(
  digests: readonly CompleteDigest[],
  picks: GradingSheet['picks'],
): Selection[] {
  if (picks.length === 0) {
    throw new DigestError(
      'The grading sheet needs at least one pick: selection agreement compares your pick ' +
        "between two drafts of a week with the judge's.",
    );
  }
  return picks.map(({ week, better }) => {
    const drafts = digests.filter((d) => d.week === week);
    const writers = new Set(drafts.map((d) => d.writer));
    if (writers.size < 2) {
      throw new DigestError(
        `Cannot compare drafts of ${week}: the sheet needs digests from two different writers, it has ${writers.size}.`,
      );
    }
    if (!drafts.some((d) => d.writer === better)) {
      throw new DigestError(
        `The pick for ${week} names "${better}", which has no digest that week (writers: ${[...writers].join(', ')}).`,
      );
    }
    return { human: better, judge: judgePick(drafts) };
  });
}
