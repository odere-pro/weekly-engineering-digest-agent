import { REPLAY_TOP_N, type RescoreResult } from '../replay/types';

const num = (value: number | null, digits: number): string =>
  value === null ? 'n/a' : value.toFixed(digits);

const PERCENT = 100;

/** The text the command prints: the flags in force, then the four numbers. */
export function formatResult(profile: string, result: RescoreResult): string {
  const accuracy =
    result.classifierAccuracy === null
      ? 'n/a'
      : `${(result.classifierAccuracy * PERCENT).toFixed(1)}%`;
  return [
    `profile: ${profile}  rescoreWithWriter: ${result.rescoreWithWriter ? 'on' : 'off'}  calibration: ${result.calibrated ? 'on' : 'off'}  pairwise: ${result.pairwise ? 'on' : 'off'}  weeks: ${result.weeks}`,
    `must-include recall: ${num(result.mustIncludeRecall, 2)} of ${REPLAY_TOP_N}`,
    `must-exclude leaks: ${num(result.mustExcludeLeaks, 2)}`,
    `classifier accuracy: ${accuracy}`,
    `seconds per week: ${num(result.secondsPerWeek, 1)}`,
    '',
  ].join('\n');
}
