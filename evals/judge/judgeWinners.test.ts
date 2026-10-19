// The judge run over the winners of the replayed weeks, called directly. `judgeInHarness.test.ts`
// runs the same code through `runEval`.
import { describe, expect, it, vi } from 'vitest';
import type { EvalJudge } from './evalJudge';
import { judgedQuality, judgeWinners, type WinnerSample } from './judgeWinners';
import { renderDigest } from '../../src/render/markdown';
import type { Draft, Item } from '../../src/domain/schemas';
import { DigestError } from '../../src/shared/errors';
import type { Logger } from '../../src/shared/telemetry';
import { makeDigest, makeItem } from '../../test/builders';
import { noopLogger } from '../../test/fakes';

interface Asked {
  draft: Draft;
  sources: readonly Item[];
}

/** Scores each call with the next of `scores`; an Error in the list is thrown instead. */
function scriptedJudge(scores: readonly (number | Error)[]) {
  const asked: Asked[] = [];
  const judge: EvalJudge = {
    model: 'clef:latest',
    score: (draft, sources) => {
      const next = scores[asked.length];
      asked.push({ draft, sources });
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ writer: draft.writer, score: next ?? 3, byCriterion: {} });
    },
  };
  return { judge, asked };
}

function sampleOf(weekId: string, overrides: Partial<WinnerSample> = {}): WinnerSample {
  const items = [makeItem(), makeItem()];
  return {
    weekId,
    markdown: renderDigest(makeDigest(items, { weekId }), { disabledGuards: [] }),
    record: { winner: 'gemma' },
    items,
    ...overrides,
  };
}

describe('judgeWinners', () => {
  it('asks the judge about the winning writer, with the digest as written and the week items', async () => {
    const sample = sampleOf('2026-W40');
    const { judge, asked } = scriptedJudge([4]);

    await judgeWinners([sample], judge, noopLogger);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.draft.writer).toBe('gemma');
    expect(asked[0]?.draft.digest.weekId).toBe('2026-W40');
    expect(asked[0]?.draft.digest.items.map((entry) => entry.itemId)).toEqual(
      sample.items.map((item) => item.id),
    );
    expect(asked[0]?.sources).toBe(sample.items);
  });

  it('returns the scores in week order and the judge model', async () => {
    const { judge } = scriptedJudge([4, 2.5]);

    const judged = await judgeWinners(
      [sampleOf('2026-W40'), sampleOf('2026-W41')],
      judge,
      noopLogger,
    );

    expect(judged).toEqual({ model: 'clef:latest', scores: [4, 2.5], failedWeeks: [] });
  });

  it('skips a week that wrote no digest, without asking the judge', async () => {
    const { judge, asked } = scriptedJudge([5]);

    const judged = await judgeWinners(
      [sampleOf('2026-W40', { markdown: undefined }), sampleOf('2026-W41')],
      judge,
      noopLogger,
    );

    expect(asked).toHaveLength(1);
    expect(judged?.scores).toEqual([5]);
  });

  it('skips a week with no winner, without asking the judge', async () => {
    const { judge, asked } = scriptedJudge([5]);

    const judged = await judgeWinners(
      [sampleOf('2026-W40', { record: { winner: null } }), sampleOf('2026-W41')],
      judge,
      noopLogger,
    );

    expect(asked).toHaveLength(1);
    expect(judged?.scores).toEqual([5]);
  });

  it('is undefined when no week had a winner, so the judge was never asked', async () => {
    const { judge, asked } = scriptedJudge([]);

    const judged = await judgeWinners(
      [
        sampleOf('2026-W40', { record: { winner: null } }),
        sampleOf('2026-W41', { markdown: undefined }),
      ],
      judge,
      noopLogger,
    );

    expect(judged).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('is undefined for no weeks at all', async () => {
    const { judge } = scriptedJudge([]);

    expect(await judgeWinners([], judge, noopLogger)).toBeUndefined();
  });

  it('lists and logs a week the judge cannot score, and keeps the other scores', async () => {
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn };
    const { judge } = scriptedJudge([new DigestError('no usable score'), 4]);

    const judged = await judgeWinners([sampleOf('2026-W40'), sampleOf('2026-W41')], judge, logger);

    expect(judged).toEqual({ model: 'clef:latest', scores: [4], failedWeeks: ['2026-W40'] });
    expect(warn).toHaveBeenCalledWith('Eval judge failed on a week', {
      weekId: '2026-W40',
      error: 'no usable score',
    });
  });

  it('is a result, not undefined, when the judge failed on every week it was asked about', async () => {
    const { judge } = scriptedJudge([new DigestError('a')]);

    const judged = await judgeWinners([sampleOf('2026-W40')], judge, noopLogger);

    expect(judged).toEqual({ model: 'clef:latest', scores: [], failedWeeks: ['2026-W40'] });
  });

  it('does not hide a bug in the judge: an error that is not a DigestError propagates', async () => {
    const { judge } = scriptedJudge([new TypeError('judge broke')]);

    await expect(judgeWinners([sampleOf('2026-W40')], judge, noopLogger)).rejects.toThrow(
      'judge broke',
    );
  });

  it('asks one week at a time, in order', async () => {
    const order: string[] = [];
    let running = 0;
    const judge: EvalJudge = {
      model: 'clef:latest',
      score: async (draft) => {
        running += 1;
        expect(running).toBe(1);
        order.push(draft.digest.weekId);
        await Promise.resolve();
        running -= 1;
        return { writer: draft.writer, score: 3, byCriterion: {} };
      },
    };

    await judgeWinners([sampleOf('2026-W40'), sampleOf('2026-W41')], judge, noopLogger);

    expect(order).toEqual(['2026-W40', '2026-W41']);
  });
});

describe('judgedQuality', () => {
  it('is the mean score, noted as scored by the judge inside the harness', () => {
    const quality = judgedQuality({ model: 'clef:latest', scores: [4, 3], failedWeeks: [] });

    expect(quality.value).toBe(3.5);
    expect(quality.note).toBe(
      'scored by clef:latest inside the harness (the profile has no judge)',
    );
  });

  it('names the weeks the judge failed on', () => {
    const quality = judgedQuality({
      model: 'clef:latest',
      scores: [4],
      failedWeeks: ['2026-W40', '2026-W41'],
    });

    expect(quality.value).toBe(4);
    expect(quality.note).toBe(
      'scored by clef:latest inside the harness (the profile has no judge); ' +
        'judge failed on 2026-W40, 2026-W41',
    );
  });

  it('is not measured when the judge scored no week', () => {
    const quality = judgedQuality({ model: 'clef:latest', scores: [], failedWeeks: ['2026-W40'] });

    expect(quality.value).toBeNull();
    expect(quality.note).toContain('judge failed on 2026-W40');
  });
});
