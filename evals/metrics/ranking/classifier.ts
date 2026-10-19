import { measured, type Measurement } from '../measurement/measurement';
import { EPSILON, share } from '../measurement/numbers';
import { spearman } from './spearman';

/** The threshold sweep's classifier measure: a relevance within this distance is right. */
const RELEVANCE_TOLERANCE = 0.5;
/** The scorecard's classifier measure: a relevance within this many points is right (0-3 scale). */
const RANKING_TOLERANCE = 1;

export interface ClassifierResult {
  expected: { area: string; relevance: number };
  actual: { area: string; relevance: number };
}

const sameArea = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Three numbers over the labeled cases: the share with the right area, the share with a relevance
 * within one point of the label, and the Spearman correlation of predicted and labeled relevance
 * (how well the classifier ranks, which is what the top-N cut needs). The value, and the gate, is
 * the within-one share; `spearman` is left out when it is undefined.
 */
export function classifierRanking(results: readonly ClassifierResult[]): Measurement {
  const area = share(
    results.filter((r) => sameArea(r.expected.area, r.actual.area)).length,
    results.length,
  );
  const withinOne = share(
    results.filter(
      (r) => Math.abs(r.expected.relevance - r.actual.relevance) <= RANKING_TOLERANCE + EPSILON,
    ).length,
    results.length,
  );
  if (area === null || withinOne === null) return measured(null);
  const rho = spearman(
    results.map((r) => ({ expected: r.expected.relevance, actual: r.actual.relevance })),
  );
  return measured(withinOne, {
    area,
    relevanceWithinOne: withinOne,
    ...(rho === null ? {} : { spearman: rho }),
  });
}

/**
 * The old measure, kept for the threshold sweep and the rescore replay, which compare runs of
 * their own: a case is right when the area and a relevance within half a point both match. The
 * scorecard no longer uses it (see `classifierRanking`).
 */
export function classifierAccuracy(results: readonly ClassifierResult[]): Measurement {
  const areaRight = results.map((r) => sameArea(r.expected.area, r.actual.area));
  const relevanceRight = results.map(
    (r) => Math.abs(r.expected.relevance - r.actual.relevance) <= RELEVANCE_TOLERANCE + EPSILON,
  );
  const both = areaRight.filter((right, i) => right && relevanceRight[i]).length;
  const area = share(areaRight.filter(Boolean).length, results.length);
  const relevance = share(relevanceRight.filter(Boolean).length, results.length);
  if (area === null || relevance === null) return measured(null);
  return measured(both / results.length, { area, relevance });
}
