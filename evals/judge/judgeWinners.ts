// Scores the winning digest of each replayed week with the eval judge (F10), for a profile whose
// select step has no judge to do it.
import { parseDigestMarkdown } from '../metrics/digest/parseDigest';
import { writingQuality } from '../metrics/judging/judgeMetrics';
import type { Measurement } from '../metrics/measurement/measurement';
import { mean } from '../metrics/measurement/numbers';
import type { Draft, Item } from '../../src/domain/schemas';
import type { RunRecord } from '../../src/store/runRecord';
import { DigestError, errorMessage } from '../../src/shared/errors';
import type { Logger } from '../../src/shared/telemetry';
import type { JudgeCriterion } from '../../src/select/judgePrompt';
import type { EvalJudge } from './evalJudge';

/** The criterion `accuracy` reports; typed, so renaming it in the rubric breaks this file. */
const ACCURACY: JudgeCriterion = 'accuracy';

/** One replayed week as far as judging it is concerned. */
export interface WinnerSample {
  weekId: string;
  /** The digest the run wrote; undefined when it produced none. */
  markdown: string | undefined;
  /** The run's record; its `winner` is the writer of that digest, null when no draft won. */
  record: Pick<RunRecord, 'winner'>;
  /** The items the replay served: the sources the digest can cite. */
  items: readonly Item[];
}

export interface JudgedWinners {
  /** The judge model. */
  model: string;
  scores: number[];
  /**
   * The judge's accuracy rating (1-5, `byCriterion.accuracy`) of the scored winners, in week
   * order. A week whose reply has none adds nothing, so this can be shorter than `scores`.
   * Reported, never gated.
   */
  accuracies: number[];
  /** Weeks whose winner the judge could not score. */
  failedWeeks: string[];
}

/** The winning draft of a replay, read back from the digest it wrote; undefined without one. */
function winningDraft({ weekId, markdown, record, items }: WinnerSample): Draft | undefined {
  if (markdown === undefined || record.winner === null) return undefined;
  return { writer: record.winner, digest: parseDigestMarkdown(markdown, weekId, items) };
}

/**
 * Scores every winner with the eval judge, one at a time. A week the judge cannot score (a
 * DigestError: the model failed or gave no usable score) is listed and logged, and the other
 * weeks keep their scores; any other error is a bug and propagates. Weeks without a winner are
 * skipped. undefined when no week had a winner, so the judge was never asked.
 */
export async function judgeWinners(
  samples: readonly WinnerSample[],
  judge: EvalJudge,
  logger: Logger,
): Promise<JudgedWinners | undefined> {
  const scores: number[] = [];
  const accuracies: number[] = [];
  const failedWeeks: string[] = [];
  for (const sample of samples) {
    const draft = winningDraft(sample);
    if (!draft) continue;
    try {
      const judgement = await judge.score(draft, sample.items);
      scores.push(judgement.score);
      const accuracy = judgement.byCriterion[ACCURACY];
      if (accuracy !== undefined && Number.isFinite(accuracy)) accuracies.push(accuracy);
    } catch (error) {
      if (!(error instanceof DigestError)) throw error;
      failedWeeks.push(sample.weekId);
      logger.warn('Eval judge failed on a week', {
        weekId: sample.weekId,
        error: errorMessage(error),
      });
    }
  }
  return scores.length + failedWeeks.length === 0
    ? undefined
    : { model: judge.model, scores, accuracies, failedWeeks };
}

/**
 * Writing quality from the eval judge's scores; the note says who scored and what failed. The
 * detail holds the mean of the judge's accuracy ratings: reported next to the score, never gated.
 */
export function judgedQuality(judged: JudgedWinners): Measurement {
  const accuracy = mean(judged.accuracies);
  const failed =
    judged.failedWeeks.length > 0 ? [`judge failed on ${judged.failedWeeks.join(', ')}`] : [];
  const note = [
    `scored by ${judged.model} inside the harness (the profile has no judge)`,
    ...failed,
  ].join('; ');
  const quality = writingQuality(judged.scores);
  const detail = accuracy === null ? {} : { detail: { ...quality.detail, meanAccuracy: accuracy } };
  return { ...quality, ...detail, note };
}
