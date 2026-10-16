import { ExitCode, type Draft, type Item, type JudgeScore } from '../schemas.js';
import type { DecisionAnswer, ModelProvider } from '../../ports/ModelProvider.js';
import { DigestError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';
import {
  buildJudgeQuestions,
  buildJudgeState,
  JUDGE_CRITERIA,
  JUDGE_LEVELS,
  resolveDraftSources,
  type JudgeCriterion,
} from '../prompts/judge.js';

export interface SelectDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  /** Config order of writers; ties go to the first. */
  writerOrder: readonly string[];
  logger: Logger;
}

export interface SelectOutput {
  winner: Draft;
  /** Empty when only one draft passed (judge skipped). */
  scores: JudgeScore[];
}

interface JudgedDraft {
  draft: Draft;
  score: JudgeScore;
}

/** Overall scores closer than this are a tie; absorbs floating-point noise from averaging. */
const SCORE_TIE_EPSILON = 1e-9;

/** Judge scores each passing draft separately; highest wins (W1-10). */
export async function selectStep(
  drafts: readonly Draft[],
  sources: readonly Item[],
  deps: SelectDeps,
): Promise<SelectOutput> {
  const [first, ...others] = drafts;
  if (first === undefined) {
    throw new DigestError('No draft passed the guards and checks', {
      exitCode: ExitCode.Blocked,
      step: 'select',
    });
  }
  if (others.length === 0) {
    deps.logger.info('one draft passed, judge skipped', { writer: first.writer });
    return { winner: first, scores: [] };
  }
  const judged = await judgeOneByOne(drafts, sources, deps);
  return { winner: pickWinner(judged, deps.writerOrder), scores: judged.map((j) => j.score) };
}

/** One judge call per draft, in turn: a draft never shares a call with another. */
async function judgeOneByOne(
  drafts: readonly Draft[],
  sources: readonly Item[],
  deps: SelectDeps,
): Promise<JudgedDraft[]> {
  const questions = buildJudgeQuestions(deps.focusAreas);
  const judged: JudgedDraft[] = [];
  for (const draft of drafts) {
    const { found, missingCount } = resolveDraftSources(draft, sources);
    if (missingCount > 0) {
      deps.logger.warn('draft cites items that were not collected', {
        writer: draft.writer,
        missingCount,
      });
    }
    const result = await deps.model.decide({
      role: 'judge',
      state: buildJudgeState(draft, found),
      questions,
    });
    const score = toJudgeScore(draft.writer, result.answers);
    deps.logger.info('draft scored', { writer: score.writer, score: score.score });
    judged.push({ draft, score });
  }
  return judged;
}

function toJudgeScore(
  writer: string,
  answers: Readonly<Record<string, DecisionAnswer>>,
): JudgeScore {
  const byCriterion: Record<string, number> = {};
  for (const criterion of JUDGE_CRITERIA) {
    byCriterion[criterion] = toRating(writer, criterion, answers);
  }
  const ratings = Object.values(byCriterion);
  const score = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
  return { writer, score, byCriterion };
}

/** Level index (0 = lowest) -> 1-5 rating, kept inside the rubric's range. */
function toRating(
  writer: string,
  criterion: JudgeCriterion,
  answers: Readonly<Record<string, DecisionAnswer>>,
): number {
  const answer = answers[criterion];
  if (answer?.type !== 'score' || !Number.isFinite(answer.level)) {
    throw new DigestError(
      `Judge gave no usable score for "${criterion}" on the draft by ${writer}`,
      {
        step: 'select',
      },
    );
  }
  const level = Math.min(Math.max(answer.level, 0), JUDGE_LEVELS.length - 1);
  return level + 1;
}

/** Highest overall score; a tie goes to the writer listed first in config. */
function pickWinner(judged: readonly JudgedDraft[], writerOrder: readonly string[]): Draft {
  const rank = (writer: string): number => {
    const index = writerOrder.indexOf(writer);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const beats = (challenger: JudgedDraft, best: JudgedDraft): boolean => {
    const gap = challenger.score.score - best.score.score;
    if (Math.abs(gap) > SCORE_TIE_EPSILON) return gap > 0;
    return rank(challenger.draft.writer) < rank(best.draft.writer);
  };
  return judged.reduce((best, challenger) => (beats(challenger, best) ? challenger : best)).draft;
}
