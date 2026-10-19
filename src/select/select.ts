import { ExitCode, type Draft, type Item } from '../domain/schemas';
import { type JudgeScore } from './judgeScore';
import type { DecideRequest, DecisionAnswer, ModelProvider } from '../models/ModelProvider';
import { DigestError, errorMessage } from '../shared/errors';
import type { Logger } from '../shared/telemetry';
import { truncate } from '../shared/text';
import {
  buildJudgeQuestions,
  buildJudgeState,
  JUDGE_CRITERIA,
  JUDGE_LEVELS,
  resolveDraftSources,
  type JudgeCriterion,
} from './judgePrompt';

export interface SelectDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  /** Config order of writers; ties go to the first. */
  writerOrder: readonly string[];
  logger: Logger;
  /**
   * The run's abort signal: given to every judge call, and no new call starts once it fires. The
   * step then rejects with the signal's reason; an abort is not a judge failure, so no writer
   * wins by default.
   */
  signal?: AbortSignal;
}

export interface SelectOutput {
  winner: Draft;
  /** Empty when the judge did not decide: one draft passed, or the judge failed. */
  scores: JudgeScore[];
  /**
   * True when the judge's scores picked the winner (same as `scores` being non-empty). False when
   * only one draft passed, or when the judge failed and the first draft in writer order won.
   */
  judged: boolean;
}

interface JudgedDraft {
  draft: Draft;
  score: JudgeScore;
}

/** A judge error can carry a long server message; the warning keeps its start. */
const LOGGED_ERROR_MAX_CHARS = 300;

/** Overall scores closer than this are a tie; absorbs floating-point noise from averaging. */
const SCORE_TIE_EPSILON = 1e-9;

/**
 * Judge scores each passing draft separately; highest wins (W1-10). If the judge fails or gives
 * an unusable answer, the first draft in writer order wins, with a warning and no scores (F33).
 * Unless the run's signal fired: then the step rejects, whatever the judge call threw.
 */
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
    return { winner: first, scores: [], judged: false };
  }
  // Building the judge's input is plain code: a bug there should fail loudly, not look like an outage.
  const prepared = prepareJudgeCalls(drafts, sources, deps);
  const questions = buildJudgeQuestions(deps.focusAreas);
  try {
    const judged = await judgeOneByOne(prepared, questions, deps);
    return {
      winner: pickWinner(judged, deps.writerOrder),
      scores: judged.map((j) => j.score),
      judged: true,
    };
  } catch (error) {
    deps.signal?.throwIfAborted();
    return fallBackToWriterOrder(drafts, error, deps);
  }
}

/** The judge could not decide: the draft whose writer comes first in config order wins. */
function fallBackToWriterOrder(
  drafts: readonly Draft[],
  error: unknown,
  deps: SelectDeps,
): SelectOutput {
  const rank = writerRank(deps.writerOrder);
  const winner = drafts.reduce((best, draft) =>
    rank(draft.writer) < rank(best.writer) ? draft : best,
  );
  deps.logger.warn('judge failed, using the first draft in writer order', {
    writer: winner.writer,
    error: truncate(errorMessage(error), LOGGED_ERROR_MAX_CHARS),
  });
  return { winner, scores: [], judged: false };
}

/** Position in config order; writers the config does not list come after all that it does. */
function writerRank(writerOrder: readonly string[]): (writer: string) => number {
  return (writer) => {
    const index = writerOrder.indexOf(writer);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
}

interface PreparedDraft {
  draft: Draft;
  /** What the judge sees: this draft and only its own source items. */
  state: string;
}

function prepareJudgeCalls(
  drafts: readonly Draft[],
  sources: readonly Item[],
  deps: SelectDeps,
): PreparedDraft[] {
  return drafts.map((draft) => {
    const { found, missingCount } = resolveDraftSources(draft, sources);
    if (missingCount > 0) {
      deps.logger.warn('draft cites items that were not collected', {
        writer: draft.writer,
        missingCount,
      });
    }
    return { draft, state: buildJudgeState(draft, found) };
  });
}

/** One judge call per draft, in turn: a draft never shares a call with another. */
async function judgeOneByOne(
  prepared: readonly PreparedDraft[],
  questions: DecideRequest['questions'],
  deps: SelectDeps,
): Promise<JudgedDraft[]> {
  const judged: JudgedDraft[] = [];
  for (const { draft, state } of prepared) {
    deps.signal?.throwIfAborted();
    const result = await deps.model.decide({
      role: 'judge',
      state,
      questions,
      signal: deps.signal,
    });
    const score = toJudgeScore(draft.writer, result.answers);
    deps.logger.info('draft scored', { writer: score.writer, score: score.score });
    judged.push({ draft, score });
  }
  return judged;
}

/**
 * The judge's answers about one draft as a 1-5 score per criterion and their mean. Exported so
 * that the eval judge (evals/judge/evalJudge.ts) converts answers exactly as this step does.
 * Throws a DigestError when a criterion has no usable score.
 */
export function toJudgeScore(
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
  const rank = writerRank(writerOrder);
  const beats = (challenger: JudgedDraft, best: JudgedDraft): boolean => {
    const gap = challenger.score.score - best.score.score;
    if (Math.abs(gap) > SCORE_TIE_EPSILON) return gap > 0;
    return rank(challenger.draft.writer) < rank(best.draft.writer);
  };
  return judged.reduce((best, challenger) => (beats(challenger, best) ? challenger : best)).draft;
}
