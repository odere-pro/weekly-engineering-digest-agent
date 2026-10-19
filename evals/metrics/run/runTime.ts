import { measured, type Measurement } from '../measurement/measurement';
import { mean } from '../measurement/numbers';

/** Mean wall-clock time per week; detail has the total. Reported, not gated. */
export function runTime(durationsMs: readonly number[]): Measurement {
  const total = durationsMs.reduce((sum, ms) => sum + ms, 0);
  return measured(mean(durationsMs), durationsMs.length === 0 ? {} : { totalMs: total });
}
