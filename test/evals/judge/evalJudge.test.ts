// The judge the harness uses on a profile that has none (F10): it asks the judge model the same
// four rubric questions the select step asks, about one draft at a time.
import { describe, expect, it } from 'vitest';
import { createEvalJudge, evalJudgeTag } from '../../../evals/judge/evalJudge.js';
import {
  JUDGE_CRITERIA,
  buildJudgeQuestions,
  buildJudgeState,
  resolveDraftSources,
} from '../../../src/core/prompts/judge.js';
import type { DecisionAnswer } from '../../../src/ports/ModelProvider.js';
import { selectStep } from '../../../src/core/steps/select.js';
import { DigestError } from '../../../src/shared/errors.js';
import { makeDraft, makeItem } from '../../builders.js';
import { FakeModelProvider, noopLogger } from '../../fakes/index.js';

const FOCUS = ['AI models and tooling', 'Platform engineering'];

const score = (level: number): DecisionAnswer => ({
  type: 'score',
  level,
  score: level / 4,
  probabilities: {},
  confidence: 1,
});

/** Answers each criterion with its level (0 is the lowest, so the rating is level + 1). */
const levels = (byCriterion: Record<string, number>) => (): Record<string, DecisionAnswer> =>
  Object.fromEntries(Object.entries(byCriterion).map(([id, level]) => [id, score(level)]));

describe('evalJudgeTag', () => {
  it('is the EVAL_JUDGE model tag, trimmed', () => {
    expect(evalJudgeTag({ EVAL_JUDGE: '  clef:latest ' })).toBe('clef:latest');
  });

  it('is undefined when EVAL_JUDGE is not set or blank', () => {
    expect(evalJudgeTag({})).toBeUndefined();
    expect(evalJudgeTag({ EVAL_JUDGE: '' })).toBeUndefined();
    expect(evalJudgeTag({ EVAL_JUDGE: '   ' })).toBeUndefined();
  });
});

describe('createEvalJudge', () => {
  const items = [makeItem(), makeItem(), makeItem()];
  const draft = makeDraft(items, 'gemma');

  it('asks the judge role the rubric questions about the draft and its own sources', async () => {
    const provider = new FakeModelProvider({
      decide: levels({ accuracy: 3, clarity: 3, whyItMatters: 3, focusFit: 3 }),
    });
    const judge = createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS });

    await judge.score(draft, [...items, makeItem()]);

    expect(provider.decideCalls).toHaveLength(1);
    const [call] = provider.decideCalls;
    expect(call?.role).toBe('judge');
    expect(call?.questions).toEqual(buildJudgeQuestions(FOCUS));
    expect(call?.state).toBe(buildJudgeState(draft, resolveDraftSources(draft, items).found));
  });

  it('turns the answers into a 1-5 score: the mean of the four ratings', async () => {
    const provider = new FakeModelProvider({
      decide: levels({ accuracy: 4, clarity: 3, whyItMatters: 2, focusFit: 3 }),
    });
    const judge = createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS });

    const result = await judge.score(draft, items);

    expect(result).toEqual({
      writer: 'gemma',
      score: 4,
      byCriterion: { accuracy: 5, clarity: 4, whyItMatters: 3, focusFit: 4 },
    });
  });

  it('keeps a level outside the rubric inside 1 to 5', async () => {
    const provider = new FakeModelProvider({
      decide: levels({ accuracy: 9, clarity: -2, whyItMatters: 0, focusFit: 4 }),
    });
    const judge = createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS });

    const result = await judge.score(draft, items);

    expect(result.byCriterion).toEqual({ accuracy: 5, clarity: 1, whyItMatters: 1, focusFit: 5 });
  });

  it('names the judge model it was built for', () => {
    const provider = new FakeModelProvider();
    expect(createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS }).model).toBe(
      'clef:latest',
    );
  });

  it('fails, naming the criterion and the writer, when the judge gives no usable score', async () => {
    const answers = Object.fromEntries(JUDGE_CRITERIA.map((id) => [id, score(3)]));
    const provider = new FakeModelProvider({
      decide: () => ({ ...answers, clarity: { type: 'yesno', probability: 0.5 } }),
    });
    const judge = createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS });

    const failure = judge.score(draft, items);

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow('no usable score for "clarity" on the draft by gemma');
  });

  it('fails on a level that is not a number', async () => {
    const provider = new FakeModelProvider({
      decide: levels({ accuracy: Number.NaN, clarity: 3, whyItMatters: 3, focusFit: 3 }),
    });
    const judge = createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS });

    await expect(judge.score(draft, items)).rejects.toThrow('"accuracy"');
  });

  it('passes a model failure on', async () => {
    const provider = new FakeModelProvider({
      decide: () => {
        throw new Error('model unloaded');
      },
    });
    const judge = createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS });

    await expect(judge.score(draft, items)).rejects.toThrow('model unloaded');
  });

  it('scores a draft exactly as the select step does, so the two profiles measure alike', async () => {
    const drafts = [makeDraft(items, 'a'), makeDraft(items, 'b')];
    // The same answers for each draft in turn, with levels outside the rubric to compare clamping.
    const answers = [
      { accuracy: 4, clarity: 3, whyItMatters: 2, focusFit: 1 },
      { accuracy: 9, clarity: -2, whyItMatters: 0, focusFit: 3 },
    ];
    const providerWithTheAnswers = () => {
      let call = 0;
      return new FakeModelProvider({ decide: () => levels(answers[call++] ?? {})() });
    };

    const selected = await selectStep(drafts, items, {
      model: providerWithTheAnswers(),
      focusAreas: FOCUS,
      writerOrder: ['a', 'b'],
      logger: noopLogger,
    });
    const judge = createEvalJudge({
      provider: providerWithTheAnswers(),
      model: 'clef:latest',
      focusAreas: FOCUS,
    });
    const scores = [await judge.score(drafts[0]!, items), await judge.score(drafts[1]!, items)];

    expect(scores).toEqual(selected.scores);
  });
});
