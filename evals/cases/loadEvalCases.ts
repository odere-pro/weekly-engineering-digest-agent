import { join } from 'node:path';
import {
  AttackCaseSchema,
  ClassifierCasesFileSchema,
  GroundingCaseSchema,
  JudgeCalibrationSchema,
} from '../schema';
import { loadSourceRecordings } from '../sourceConformance/recordings/loadSourceRecordings';
import { assertAttacksAreDistinct, loadCaseDir } from './caseFiles';
import type { EvalCases } from './evalSet';
import { readJson, requireFolder } from './jsonFiles';
import { loadWeeks } from './loadWeeks';

/** The npm package ships no `evals/`, so a missing folder usually means "not a clone". */
const CLONE_HINT =
  '"digest eval" needs the evals/ folder of a clone of the repository; the npm package does not include it.';

/**
 * Everything the eval needs from disk. A missing cases folder throws; missing case folders and
 * files inside it are empty sets (a hard gate then cannot pass). Bad files throw, naming the file.
 */
export async function loadEvalCases(casesDir: string): Promise<EvalCases> {
  await requireFolder(casesDir, CLONE_HINT);
  const classifier = await readJson(
    join(casesDir, 'classifier-cases.json'),
    ClassifierCasesFileSchema,
  );
  const weeks = await loadWeeks(join(casesDir, 'weeks'));
  const attacks = await loadCaseDir(join(casesDir, 'attacks'), AttackCaseSchema, 'attack');
  assertAttacksAreDistinct(attacks, weeks);
  return {
    weeks,
    classifier: classifier ?? { reviewed: false, cases: [] },
    attacks,
    grounding: await loadCaseDir(join(casesDir, 'grounding'), GroundingCaseSchema, 'grounding'),
    calibration:
      (await readJson(join(casesDir, 'judge', 'calibration.json'), JudgeCalibrationSchema)) ?? null,
    sources: await loadSourceRecordings(join(casesDir, 'sources')),
  };
}
