import type { EvalCases } from '../../cases/evalSet';
import { mean } from '../../metrics/measurement/numbers';
import {
  mustExcludeLeaks,
  mustIncludeRecall,
  type WeekHits,
} from '../../metrics/ranking/labelHits';
import { replayClassifierCases } from './replayClassifierCases';
import { replayWeek } from './replayWeek';
import type { RescoreReplayDeps, RescoreResult } from './types';

/** One pass over the recorded weeks and the classifier cases with the flag at `rescore`. */
export async function replayRescore(
  cases: EvalCases,
  deps: RescoreReplayDeps,
  rescore: boolean,
): Promise<RescoreResult> {
  const runs: { hits: WeekHits; seconds: number }[] = [];
  for (const week of cases.weeks) runs.push(await replayWeek(week, deps, rescore));
  const hits = runs.map((run) => run.hits);
  return {
    rescoreWithWriter: rescore,
    ...(deps.pairwise ? { pairwise: true } : {}),
    ...(deps.calibration ? { calibrated: true } : {}),
    weeks: cases.weeks.length,
    mustIncludeRecall: mustIncludeRecall(hits).value,
    mustExcludeLeaks: mustExcludeLeaks(hits).value,
    classifierAccuracy: await replayClassifierCases(cases.classifier.cases, deps, rescore),
    secondsPerWeek: mean(runs.map((run) => run.seconds)),
  };
}
