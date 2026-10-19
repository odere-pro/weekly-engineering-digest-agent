import type { Item } from '../../src/domain/schemas';
import type {
  AttackCase,
  ClassifierCase,
  GroundingCase,
  JudgeCalibration,
  WeekLabels,
} from '../schema';
import type { SourceRecording } from '../sourceEval';

/** One recorded ISO week: the items the feeds served and the maintainer's labels. */
export interface EvalWeek {
  weekId: string;
  items: Item[];
  labels: WeekLabels;
}

/** Everything the eval needs from disk. */
export interface EvalCases {
  weeks: EvalWeek[];
  classifier: { reviewed: boolean; cases: ClassifierCase[] };
  attacks: AttackCase[];
  grounding: GroundingCase[];
  calibration: JudgeCalibration | null;
  sources: SourceRecording[];
}

/** How many of each kind of case a set has. */
export interface EvalSetSize {
  weeks: number;
  attacks: number;
  grounding: number;
  classifier: number;
}

/**
 * The set a full eval needs; a hard gate fails on fewer cases. The numbers come from the spec's
 * eval section and match the data folders (`weeks/`, `attacks/`, `grounding/`,
 * `classifier-cases.json`); the `dataset.*` tests pin them.
 */
export const SPEC_EVAL_SET: EvalSetSize = { weeks: 6, attacks: 30, grounding: 30, classifier: 60 };
