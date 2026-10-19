import { classifyStep } from '../../../src/classify/classify';
import { calibrateClassification } from '../../../src/process/calibration';
import type { EvalCases } from '../../cases/evalSet';
import { classifierAccuracy } from '../../metrics/ranking/classifier';
import { classifyDeps } from './replayInputs';
import type { RescoreReplayDeps } from './types';

/** Share of the classifier cases with the right area and relevance; null for no case. */
export async function replayClassifierCases(
  cases: EvalCases['classifier']['cases'],
  deps: RescoreReplayDeps,
  rescore: boolean,
): Promise<number | null> {
  if (cases.length === 0) return null;
  const scored = await classifyStep(
    cases.map((c) => c.item),
    classifyDeps(deps, rescore),
  );
  const results = cases.flatMap((c, i) => {
    const classification = scored[i]?.classification;
    if (!classification) return [];
    const { area, relevance } = deps.calibration
      ? calibrateClassification(deps.calibration, classification)
      : classification;
    return [{ expected: c.expected, actual: { area, relevance } }];
  });
  return classifierAccuracy(results).value;
}
