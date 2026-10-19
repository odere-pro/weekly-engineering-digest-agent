// The acceptance checks of a tuning result: the spec's gates, read at the proposed thresholds.
import type { FilterSweep } from '../sweep/filter';
import type { GuardSweep } from '../sweep/guardFlag';
import { EPSILON, MAX_FALSE_BLOCK_RATE, MIN_CLASSIFIER_ACCURACY } from '../sweep/measures';
import { worst } from '../split';
import type { TuningResult } from './schema';

/** A minimum gate; a rate that could not be measured fails. */
export const atLeast = (value: number | null, min: number) => ({
  value,
  min,
  pass: value !== null && value >= min - EPSILON,
});

/** A maximum gate; a rate that could not be measured fails. */
export const atMost = (value: number | null, max: number) => ({
  value,
  max,
  pass: value !== null && value <= max + EPSILON,
});

export interface AcceptanceInput {
  /** The scorecard's classifier accuracy on the train side. */
  scorecardAccuracy: number | null;
  filter: FilterSweep;
  guard: GuardSweep;
  /** Failed model calls over the whole capture. */
  failedCalls: number;
}

export function acceptanceOf(input: AcceptanceInput): TuningResult['acceptance'] {
  const { scorecardAccuracy, filter, guard, failedCalls } = input;
  return {
    classifierAccuracy: atLeast(scorecardAccuracy, MIN_CLASSIFIER_ACCURACY),
    filterAccuracy: atLeast(filter.proposed.accuracy, MIN_CLASSIFIER_ACCURACY),
    guardFalseBlocks: atMost(
      worst([
        guard.proposed.policyFalseBlockRate,
        guard.proposed.rubricFalseBlockRate,
        guard.granite.falseBlockRate,
      ]),
      MAX_FALSE_BLOCK_RATE,
    ),
    inputFalseBlocksAnyMode: atMost(guard.proposed.anyFalseBlockRate, MAX_FALSE_BLOCK_RATE),
    failedCalls: { count: failedCalls, pass: failedCalls === 0 },
  };
}
