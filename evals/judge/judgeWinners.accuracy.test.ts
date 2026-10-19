// The judge's accuracy rating, kept next to each overall score and reported beside writing
// quality. `judgeWinners.test.ts` has the cases for the scores themselves.
import { describe, expect, it } from 'vitest';
import type { EvalJudge } from './evalJudge';
import { judgedQuality, judgeWinners, type WinnerSample } from './judgeWinners';
import { renderDigest } from '../../src/render/markdown';
import { DigestError } from '../../src/shared/errors';
import { makeDigest, makeItem } from '../../test/builders';
import { noopLogger } from '../../test/fakes';

/** A scripted reply: the overall score, and the accuracy rating when the judge gives one. */
type Reply = { score: number; accuracy?: number } | Error;

function judgeReplying(replies: readonly Reply[]): EvalJudge {
  let asked = 0;
  return {
    model: 'clef:latest',
    score: (draft) => {
      const next = replies[asked++];
      if (next === undefined || next instanceof Error) {
        return Promise.reject(next ?? new Error('no reply scripted'));
      }
      const byCriterion: Record<string, number> =
        next.accuracy === undefined ? {} : { accuracy: next.accuracy };
      return Promise.resolve({ writer: draft.writer, score: next.score, byCriterion });
    },
  };
}

function sampleOf(weekId: string): WinnerSample {
  const items = [makeItem(), makeItem()];
  return {
    weekId,
    markdown: renderDigest(makeDigest(items, { weekId }), { disabledGuards: [] }),
    record: { winner: 'gemma' },
    items,
  };
}

const WEEKS = ['2026-W40', '2026-W41', '2026-W42'].map(sampleOf);

describe('judgeWinners accuracy', () => {
  it('keeps the accuracy rating of each scored winner, in week order', async () => {
    const judge = judgeReplying([
      { score: 4, accuracy: 5 },
      { score: 2.5, accuracy: 2 },
    ]);

    const judged = await judgeWinners(WEEKS.slice(0, 2), judge, noopLogger);

    expect(judged?.scores).toEqual([4, 2.5]);
    expect(judged?.accuracies).toEqual([5, 2]);
  });

  it('keeps none for a week the judge gave none, and none for a week it failed on', async () => {
    const judge = judgeReplying([
      { score: 4 },
      new DigestError('no usable score'),
      { score: 3, accuracy: 4 },
    ]);

    const judged = await judgeWinners(WEEKS, judge, noopLogger);

    expect(judged?.scores).toEqual([4, 3]);
    expect(judged?.accuracies).toEqual([4]);
    expect(judged?.failedWeeks).toEqual(['2026-W41']);
  });

  it('keeps none that is not a number', async () => {
    const judge = judgeReplying([{ score: 4, accuracy: Number.NaN }]);

    const judged = await judgeWinners(WEEKS.slice(0, 1), judge, noopLogger);

    expect(judged?.scores).toEqual([4]);
    expect(judged?.accuracies).toEqual([]);
  });
});

describe('judgedQuality accuracy', () => {
  const base = { model: 'clef:latest', scores: [4, 3], failedWeeks: [] as string[] };

  it('reports the mean accuracy rating in the detail', () => {
    const quality = judgedQuality({ ...base, accuracies: [5, 4] });

    expect(quality.detail).toEqual({ meanAccuracy: 4.5 });
  });

  it('is reported beside a failed week, and leaves the note as it was', () => {
    const quality = judgedQuality({ ...base, accuracies: [3], failedWeeks: ['2026-W40'] });

    expect(quality.detail).toEqual({ meanAccuracy: 3 });
    expect(quality.note).toBe(
      'scored by clef:latest inside the harness (the profile has no judge); ' +
        'judge failed on 2026-W40',
    );
  });

  it('has no detail when the judge gave no accuracy', () => {
    expect(judgedQuality({ ...base, accuracies: [] }).detail).toBeUndefined();
  });

  it('changes neither the value nor the verdict: the writing quality is still the mean score', () => {
    const quality = judgedQuality({ ...base, accuracies: [1, 1] });

    expect(quality.value).toBe(3.5);
    expect(quality.complete).toBeUndefined();
  });
});
