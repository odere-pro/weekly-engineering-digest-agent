// Scores the winning digest of each replayed week with the eval judge (F10), for a profile whose
// select step has no judge to do it.
import { parseDigestMarkdown, writingQuality, type Measurement } from '../metrics';
import type { Draft, Item, RunRecord } from '../../src/domain/schemas';
import { DigestError, errorMessage } from '../../src/shared/errors';
import type { Logger } from '../../src/shared/telemetry';
import type { EvalJudge } from './evalJudge';

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
  const failedWeeks: string[] = [];
  for (const sample of samples) {
    const draft = winningDraft(sample);
    if (!draft) continue;
    try {
      scores.push((await judge.score(draft, sample.items)).score);
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
    : { model: judge.model, scores, failedWeeks };
}

/** Writing quality from the eval judge's scores; the note says who scored and what failed. */
export function judgedQuality(judged: JudgedWinners): Measurement {
  const failed =
    judged.failedWeeks.length > 0 ? [`judge failed on ${judged.failedWeeks.join(', ')}`] : [];
  const note = [
    `scored by ${judged.model} inside the harness (the profile has no judge)`,
    ...failed,
  ].join('; ');
  return { ...writingQuality(judged.scores), note };
}
