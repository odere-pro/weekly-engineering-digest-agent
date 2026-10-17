// The judge `digest eval` uses on a profile that has none (system-design D16, F10). The select
// step skips the judge when `profile.judge` is null, so on `fast` and `light` the harness asks the
// judge model itself, with the same rubric, about the winning draft of each replayed week.
import {
  JUDGE_CRITERIA,
  JUDGE_LEVELS,
  buildJudgeQuestions,
  buildJudgeState,
  resolveDraftSources,
  type JudgeCriterion,
} from '../../src/core/prompts/judge.js';
import type { Draft, Item, JudgeScore } from '../../src/core/schemas.js';
import type { DecisionAnswer, ModelProvider } from '../../src/ports/ModelProvider.js';
import { DigestError } from '../../src/shared/errors.js';

/** Scores one draft against the items it cites. */
export interface EvalJudge {
  /** Tag of the judge model; goes into the scorecard's `models`. */
  model: string;
  score(draft: Draft, sources: readonly Item[]): Promise<JudgeScore>;
}

export interface EvalJudgeOptions {
  /**
   * A provider whose profile names `model` as its judge (`{ ...profile, judge: model }`): the
   * judge role resolves to a tag through the profile, and a single-writer profile has none.
   */
  provider: ModelProvider;
  model: string;
  focusAreas: readonly string[];
}

/** The judge model tag from the environment (`EVAL_JUDGE=clef:latest`); undefined when unset. */
export function evalJudgeTag(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const tag = env.EVAL_JUDGE?.trim();
  return tag === undefined || tag === '' ? undefined : tag;
}

export function createEvalJudge({ provider, model, focusAreas }: EvalJudgeOptions): EvalJudge {
  const questions = buildJudgeQuestions(focusAreas);
  return {
    model,
    score: async (draft, sources) => {
      const { found } = resolveDraftSources(draft, sources);
      const result = await provider.decide({
        role: 'judge',
        state: buildJudgeState(draft, found),
        questions,
      });
      return toJudgeScore(draft.writer, result.answers);
    },
  };
}

// Same conversion as `toJudgeScore` in src/core/steps/select.ts, which does not export it.
function toJudgeScore(
  writer: string,
  answers: Readonly<Record<string, DecisionAnswer>>,
): JudgeScore {
  const byCriterion: Record<string, number> = {};
  for (const criterion of JUDGE_CRITERIA)
    byCriterion[criterion] = toRating(writer, criterion, answers);
  const ratings = Object.values(byCriterion);
  const score = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
  return { writer, score, byCriterion };
}

/** Level index (0 is the lowest) to a 1-5 rating, kept inside the rubric's range. */
function toRating(
  writer: string,
  criterion: JudgeCriterion,
  answers: Readonly<Record<string, DecisionAnswer>>,
): number {
  const answer = answers[criterion];
  if (answer?.type !== 'score' || !Number.isFinite(answer.level)) {
    throw new DigestError(
      `Judge gave no usable score for "${criterion}" on the draft by ${writer}`,
      { step: 'select' },
    );
  }
  return Math.min(Math.max(answer.level, 0), JUDGE_LEVELS.length - 1) + 1;
}
