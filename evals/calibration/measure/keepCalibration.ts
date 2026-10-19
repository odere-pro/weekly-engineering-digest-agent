import type { SideMeasure } from './measureSide';

/** The rule from the issue: holdout recall rises and leaks do not. */
export function keepCalibration(off: SideMeasure, on: SideMeasure): boolean {
  return on.recall > off.recall && on.leaks <= off.leaks;
}
