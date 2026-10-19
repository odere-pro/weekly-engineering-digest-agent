// The classifier thresholds (minRelevance, maxHype, maxMinorRelease): which grid point keeps or
// drops the most labelled classifier cases as the maintainer labelled them (W3-03).
import type { Classified, ClassifierRecord } from '../capture/schemas';
import { isFailed } from '../capture/schemas';
import {
  PROBABILITY_AXIS,
  RELEVANCE_AXIS,
  axisValues,
  pickOnGrid,
  type GridDimension,
} from './grid';
import { keepsItem, type FilterThresholds } from './keepsItem';
import { share } from './measures';

/** Labels at or above this relevance (relevant, must read) belong in the digest. */
export const KEEP_MIN_LABEL = 2;

type FilterKey = keyof FilterThresholds;

export interface FilterSample {
  shouldKeep: boolean;
  scores: Classified;
}

export interface FilterOutcome {
  /** Share of cases the filter keeps or drops as their label says; null without cases. */
  accuracy: number | null;
  kept: number;
  dropped: number;
  /** Kept although labelled 0 or 1. */
  wronglyKept: number;
  /** Dropped although labelled 2 or 3. */
  wronglyDropped: number;
}

export interface CurvePoint {
  value: number;
  accuracy: number | null;
}

export interface FilterSweep {
  cases: number;
  failed: number;
  chosen: FilterThresholds;
  baseline: FilterOutcome;
  proposed: FilterOutcome;
  /** Accuracy along each threshold, with the other two at the chosen values. */
  curves: Record<FilterKey, CurvePoint[]>;
}

/** The answered cases, each with whether its label says keep. */
export function filterSamples(records: readonly ClassifierRecord[]): FilterSample[] {
  return records.flatMap(({ expected, result }) =>
    isFailed(result) ? [] : [{ shouldKeep: expected.relevance >= KEEP_MIN_LABEL, scores: result }],
  );
}

export function filterOutcome(
  samples: readonly FilterSample[],
  thresholds: FilterThresholds,
): FilterOutcome {
  const kept = samples.map((s) => keepsItem(s.scores, thresholds));
  const wronglyKept = samples.filter((s, i) => kept[i] && !s.shouldKeep).length;
  const wronglyDropped = samples.filter((s, i) => !kept[i] && s.shouldKeep).length;
  const keptCount = kept.filter(Boolean).length;
  return {
    accuracy: share(samples.length - wronglyKept - wronglyDropped, samples.length),
    kept: keptCount,
    dropped: samples.length - keptCount,
    wronglyKept,
    wronglyDropped,
  };
}

const correctCount = (samples: readonly FilterSample[], thresholds: FilterThresholds): number =>
  samples.filter((s) => keepsItem(s.scores, thresholds) === s.shouldKeep).length;

function filterAxis(key: FilterKey): number[] {
  return axisValues(key === 'minRelevance' ? RELEVANCE_AXIS : PROBABILITY_AXIS);
}

/** Picks the three classifier thresholds that keep or drop the most cases as labelled. */
export function sweepFilter(
  records: readonly ClassifierRecord[],
  baseline: FilterThresholds,
): FilterSweep {
  const samples = filterSamples(records);
  const dim = (key: FilterKey): GridDimension => ({
    values: filterAxis(key),
    preferred: baseline[key],
  });
  const dims = {
    minRelevance: dim('minRelevance'),
    maxHype: dim('maxHype'),
    maxMinorRelease: dim('maxMinorRelease'),
  };
  const { point: chosen } = pickOnGrid(dims, (thresholds) => correctCount(samples, thresholds));
  const curve = (key: FilterKey): CurvePoint[] =>
    filterAxis(key).map((value) => ({
      value,
      accuracy: filterOutcome(samples, { ...chosen, [key]: value }).accuracy,
    }));
  return {
    cases: samples.length,
    failed: records.length - samples.length,
    chosen,
    baseline: filterOutcome(samples, baseline),
    proposed: filterOutcome(samples, chosen),
    curves: {
      minRelevance: curve('minRelevance'),
      maxHype: curve('maxHype'),
      maxMinorRelease: curve('maxMinorRelease'),
    },
  };
}
