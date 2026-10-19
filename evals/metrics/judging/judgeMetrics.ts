import { measured, type Measurement } from '../measurement/measurement';
import { EPSILON, mean, share } from '../measurement/numbers';

/** Spec: below this agreement with the maintainer the judge's scores are reported, not gated. */
export const JUDGE_AGREEMENT_MIN = 0.8;

/** A judge score within this distance of the maintainer's grade counts as agreement. */
const GRADE_TOLERANCE = 0.5;

/** Mean judge score (1-5) of the selected drafts. */
export function writingQuality(scores: readonly number[]): Measurement {
  return measured(mean(scores));
}

/** Share of weeks where the judge picked the draft the maintainer picked. */
export function selectionAgreement(
  picks: readonly { judge: string; human: string }[],
): Measurement {
  return measured(share(picks.filter((p) => p.judge === p.human).length, picks.length));
}

/** Share of hand-graded digests where the judge is within half a point of the maintainer. */
export function judgeAgreement(pairs: readonly { judge: number; human: number }[]): Measurement {
  const agree = pairs.filter(
    (p) => Math.abs(p.judge - p.human) <= GRADE_TOLERANCE + EPSILON,
  ).length;
  return measured(share(agree, pairs.length));
}
