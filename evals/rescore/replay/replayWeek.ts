import type { ScoredItem } from '../../../src/classify/classification';
import { classifyStep } from '../../../src/classify/classify';
import { PAIRWISE_TOP, pairwiseRank } from '../../../src/classify/pairwise';
import { processStep, type ProcessInput, type ProcessOutput } from '../../../src/process/process';
import type { EvalWeek } from '../../cases/evalSet';
import type { WeekHits } from '../../metrics/ranking/labelHits';
import { classifyDeps, servedItems } from './replayInputs';
import { REPLAY_TOP_N, type RescoreReplayDeps } from './types';

const MS_PER_SECOND = 1000;

/** The process step, with the optional pairwise re-rank of the best `PAIRWISE_TOP` survivors. */
export async function selectTop(
  scored: ScoredItem[],
  deps: RescoreReplayDeps,
): Promise<ProcessOutput> {
  const base: ProcessInput = {
    items: scored,
    sentUrls: new Set<string>(),
    thresholds: deps.config.thresholds,
    topN: REPLAY_TOP_N,
    calibration: deps.calibration,
  };
  if (!deps.pairwise) return processStep(base);
  const { selected: candidates } = processStep({ ...base, topN: PAIRWISE_TOP });
  const pairwiseOrder = await pairwiseRank(candidates, {
    model: deps.model,
    focusAreas: deps.config.focusAreas,
    logger: deps.logger,
  });
  return processStep({ ...base, pairwiseOrder });
}

/** One recorded week: serve its items, classify, pick the top 5, and time the classify and pick. */
export async function replayWeek(
  week: EvalWeek,
  deps: RescoreReplayDeps,
  rescore: boolean,
): Promise<{ hits: WeekHits; seconds: number }> {
  const served = servedItems(week.items, deps.config);
  const startMs = deps.clock.now().getTime();
  const scored = await classifyStep(served, classifyDeps(deps, rescore));
  const { selected } = await selectTop(scored, deps);
  const seconds = Math.max(0, deps.clock.now().getTime() - startMs) / MS_PER_SECOND;
  const hits: WeekHits = {
    mustInclude: week.labels.mustInclude,
    mustExclude: week.labels.mustExclude,
    digestItemIds: selected.map((item) => item.id),
    visibleIds: new Set(served.map((item) => item.id)),
  };
  return { hits, seconds };
}
