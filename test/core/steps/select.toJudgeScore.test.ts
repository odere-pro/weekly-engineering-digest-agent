// `toJudgeScore` is the one place the judge's answers become a 1-5 score: the select step and the
// eval judge (evals/judge/evalJudge.ts) both call it, so the two profiles measure alike.
import { describe, expect, it } from 'vitest';
import type { JudgeCriterion } from '../../../src/core/prompts/judge.js';
import { toJudgeScore } from '../../../src/core/steps/select.js';
import type { DecisionAnswer } from '../../../src/ports/ModelProvider.js';

const scoreAnswer = (level: number): DecisionAnswer => ({
  type: 'score',
  level,
  score: level / 4,
  probabilities: {},
  confidence: 0.9,
});

/** One score answer per rubric criterion; level 0 is the lowest. */
function answers(byCriterion: Record<JudgeCriterion, number>): Record<string, DecisionAnswer> {
  return Object.fromEntries(
    Object.entries(byCriterion).map(([id, level]) => [id, scoreAnswer(level)]),
  );
}

const MIDDLE = { accuracy: 2, clarity: 2, whyItMatters: 2, focusFit: 2 };

describe('toJudgeScore', () => {
  it('turns each 0-based level into a 1-5 rating and averages them for the overall score', () => {
    const result = toJudgeScore(
      'gemma',
      answers({ accuracy: 4, clarity: 3, whyItMatters: 2, focusFit: 1 }),
    );

    expect(result).toEqual({
      writer: 'gemma',
      score: 3.5,
      byCriterion: { accuracy: 5, clarity: 4, whyItMatters: 3, focusFit: 2 },
    });
  });

  it('keeps a level outside the rubric inside 1 to 5', () => {
    const result = toJudgeScore(
      'gemma',
      answers({ accuracy: 9, clarity: -2, whyItMatters: 0, focusFit: 3 }),
    );

    expect(result.byCriterion).toEqual({ accuracy: 5, clarity: 1, whyItMatters: 1, focusFit: 4 });
    expect(result.score).toBe(2.75);
  });

  it('keeps a fractional expected level from the decision model', () => {
    const result = toJudgeScore(
      'gemma',
      answers({ accuracy: 2.5, clarity: 3.5, whyItMatters: 1, focusFit: 3 }),
    );

    expect(result.byCriterion.accuracy).toBeCloseTo(3.5, 10);
    expect(result.byCriterion.clarity).toBeCloseTo(4.5, 10);
    expect(result.score).toBeCloseTo((3.5 + 4.5 + 2 + 4) / 4, 10);
  });

  it('names the writer it scores, whatever that tag looks like', () => {
    expect(toJudgeScore('gemma4:e4b-mlx', answers(MIDDLE)).writer).toBe('gemma4:e4b-mlx');
  });

  it('ignores answers to questions that are not rubric criteria', () => {
    const result = toJudgeScore('gemma', { ...answers(MIDDLE), extra: scoreAnswer(0) });

    expect(Object.keys(result.byCriterion)).toEqual([
      'accuracy',
      'clarity',
      'whyItMatters',
      'focusFit',
    ]);
  });

  it('does not modify the answers', () => {
    const given = Object.freeze(answers(MIDDLE));
    const snapshot = structuredClone(given);

    toJudgeScore('gemma', given);

    expect(given).toEqual(snapshot);
  });

  describe('when the judge gave no usable score', () => {
    const failure = (given: Record<string, DecisionAnswer>) => () => toJudgeScore('gemma', given);

    it('throws a DigestError for the select step, naming the criterion and the writer', () => {
      const { clarity: _dropped, ...rest } = answers(MIDDLE);

      expect(failure(rest)).toThrow(
        expect.objectContaining({
          name: 'DigestError',
          step: 'select',
          message: 'Judge gave no usable score for "clarity" on the draft by gemma',
        }),
      );
    });

    it('rejects an answer of another type', () => {
      const given = { ...answers(MIDDLE), focusFit: { type: 'yesno', probability: 0.5 } as const };

      expect(failure(given)).toThrow('"focusFit"');
    });

    it.each([
      ['not a number', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('rejects a level that is %s', (_name, level) => {
      const given = { ...answers(MIDDLE), accuracy: scoreAnswer(level) };

      expect(failure(given)).toThrow('"accuracy"');
    });
  });
});
