import type { Config } from '../../../src/config/schema';
import type { ModelProvider } from '../../../src/models/ModelProvider';
import type { Calibration } from '../../../src/process/calibration';
import type { Clock } from '../../../src/shared/clock';
import type { Logger } from '../../../src/shared/telemetry';

/** Spec: must-include recall is counted in the top 5, whatever topN the local config says. */
export const REPLAY_TOP_N = 5;

export interface RescoreReplayDeps {
  model: ModelProvider;
  config: Config;
  logger: Logger;
  clock: Clock;
  /** Applied by the process step and to the classifier cases (W11-06). Absent: as before. */
  calibration?: Calibration | undefined;
  /** Re-rank the best candidates with a pairwise tournament before the final pick (W11-07). */
  pairwise?: boolean | undefined;
}

export interface RescoreResult {
  rescoreWithWriter: boolean;
  pairwise?: boolean;
  calibrated?: boolean;
  weeks: number;
  /** Mean must-include items found in the top 5 per week (gate: at least 3). */
  mustIncludeRecall: number | null;
  mustExcludeLeaks: number | null;
  /** Share of classifier cases with the right area and relevance. */
  classifierAccuracy: number | null;
  /** Mean wall-clock seconds to classify and select one week. */
  secondsPerWeek: number | null;
}
