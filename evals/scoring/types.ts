import type { ProfileName } from '../../src/config/schema';
import type { DigestDeps } from '../../src/digest/runDigest';
import type { EvalCases, EvalSetSize, EvalWeek } from '../cases/evalSet';
import type { EvalSection } from '../checkpointSections';
import type { GroundingResults } from '../classifierRun/checkGrounding';
import type { JudgedWinners } from '../judge/judgeWinners';
import type { AttackOutcome } from '../metrics/attacks/attackHandling';
import type { ClassifierResult } from '../metrics/ranking/classifier';
import type { Replay } from '../replay/replay';
import type { SourceResult } from '../sourceEval';

export interface WeekRun {
  week: EvalWeek;
  run: Replay;
}

export interface StabilityWeek {
  weekId: string;
  runs: string[][];
  /** The replays behind `runs`, the first one included. */
  replays: Replay[];
}

export interface AttackReplay {
  run: Replay;
  outcomes: AttackOutcome[];
}

/** Everything one eval run gathered, before any metric is computed. */
export interface EvalRun {
  weekRuns: WeekRun[];
  /** Digest item ids of each run of every week, the plain replay included. */
  stabilityIds: StabilityWeek[];
  attack: AttackReplay | undefined;
  /** The plain replay of the first week, the attack replay's baseline; run for `guards` alone. */
  attackBaseline: Replay | undefined;
  classifier: ClassifierResult[];
  grounding: GroundingResults;
  /** The eval judge's scores of the winners; undefined when it was never asked. */
  judged: JudgedWinners | undefined;
  /** One result per recorded source; measured before any model call. */
  sources: SourceResult[];
}

/** What `buildScorecard` and `measure` read: the run, the set it ran on and the app's profile. */
export interface Scoring {
  profile: ProfileName;
  only: EvalSection | undefined;
  cases: EvalCases;
  run: EvalRun;
  app: DigestDeps;
  minimums: EvalSetSize;
  startMs: number;
  endMs: number;
}
