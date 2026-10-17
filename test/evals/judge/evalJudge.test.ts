// The judge the harness uses on a profile that has none (F10): it asks the judge model the same
// four rubric questions the select step asks, about one draft at a time.
import { describe, expect, it, vi } from 'vitest';
import {
  assertJudgeInstalled,
  createEvalJudge,
  evalJudgeTag,
} from '../../../evals/judge/evalJudge.js';
import {
  JUDGE_CRITERIA,
  buildJudgeQuestions,
  buildJudgeState,
  resolveDraftSources,
} from '../../../src/core/prompts/judge.js';
import type * as SelectModule from '../../../src/core/steps/select.js';
import { toJudgeScore } from '../../../src/core/steps/select.js';
import type { DecisionAnswer, ModelHealth } from '../../../src/ports/ModelProvider.js';
import { DigestError } from '../../../src/shared/errors.js';
import { makeDraft, makeItem } from '../../builders.js';
import { FakeModelProvider } from '../../fakes/index.js';

// Wraps the select step's converter, so the tests can see the judge calls that one function
// instead of a copy of it. It still does the real conversion.
vi.mock('../../../src/core/steps/select.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SelectModule>();
  return { ...actual, toJudgeScore: vi.fn(actual.toJudgeScore) };
});

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

  it("converts the answers with the select step's toJudgeScore, not a copy of it", async () => {
    const answers = levels({ accuracy: 4, clarity: 3, whyItMatters: 2, focusFit: 1 })();
    const provider = new FakeModelProvider({ decide: () => answers });
    const judge = createEvalJudge({ provider, model: 'clef:latest', focusAreas: FOCUS });
    vi.mocked(toJudgeScore).mockClear();

    const result = await judge.score(draft, items);

    expect(toJudgeScore).toHaveBeenCalledTimes(1);
    expect(toJudgeScore).toHaveBeenCalledWith('gemma', answers);
    expect(result).toEqual(vi.mocked(toJudgeScore).mock.results[0]?.value);
  });
});

describe('assertJudgeInstalled', () => {
  const TAG = 'clef:latest';
  const decision = ['completion', 'decision'];

  const providerWith = (health: ModelHealth) => new FakeModelProvider({ health });
  const installed = (...models: { name: string; capabilities?: string[] }[]): ModelHealth => ({
    reachable: true,
    version: '0.40.4',
    models: models.map(({ name, capabilities = decision }) => ({ name, capabilities })),
  });

  it('passes when Ollama lists the tag as a decision model', async () => {
    const provider = providerWith(installed({ name: 'gemma4:e4b-mlx' }, { name: TAG }));

    await expect(assertJudgeInstalled(provider, TAG)).resolves.toBeUndefined();
  });

  it.each([
    ['an untagged name for ":latest"', 'clef', 'clef:latest'],
    ['a tag for the untagged name Ollama lists', 'clef:latest', 'clef'],
    ['a registry path with a tag', 'hf.co/org/judge:Q4_K_M', 'hf.co/org/judge:Q4_K_M'],
    [
      'a registry port, which is not a version',
      'localhost:5000/judge',
      'localhost:5000/judge:latest',
    ],
  ])('matches %s', async (_name, tag, listed) => {
    const provider = providerWith(installed({ name: listed }));

    await expect(assertJudgeInstalled(provider, tag)).resolves.toBeUndefined();
  });

  it('does not take another version of the same model for the tag', async () => {
    const provider = providerWith(installed({ name: 'clef:v2' }));

    await expect(assertJudgeInstalled(provider, TAG)).rejects.toThrow('not installed');
  });

  it('fails with a DigestError that names the tag and EVAL_JUDGE when it is not installed', async () => {
    const provider = providerWith(installed({ name: 'gemma4:e4b-mlx' }));

    const failure = assertJudgeInstalled(provider, 'judge-typo:latest');

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow(
      'The eval judge "judge-typo:latest" (EVAL_JUDGE) is not installed in Ollama',
    );
  });

  it('tells the maintainer how to fix it, since it never pulls a model itself', async () => {
    const failure = assertJudgeInstalled(providerWith(installed()), TAG);

    await expect(failure).rejects.toThrow('ollama pull clef:latest');
    await expect(failure).rejects.toThrow('nothing was replayed');
  });

  it('fails when the model is installed but is not a decision model', async () => {
    const provider = providerWith(installed({ name: TAG, capabilities: ['completion'] }));

    await expect(assertJudgeInstalled(provider, TAG)).rejects.toThrow(
      'is not a decision model (no "decision" capability)',
    );
  });

  it('fails with the reason when Ollama cannot be reached', async () => {
    const provider = providerWith({
      reachable: false,
      models: [],
      error: 'Ollama is not reachable at http://localhost:11434.',
    });

    const failure = assertJudgeInstalled(provider, TAG);

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow('Ollama is not reachable at http://localhost:11434.');
    await expect(failure).rejects.toThrow('"clef:latest"');
  });

  it('keeps credentials in the Ollama URL out of the message', async () => {
    const provider = providerWith({
      reachable: false,
      models: [],
      error: 'Ollama is not reachable at https://admin:s3cret@ollama.internal:11434.',
    });

    const failure = assertJudgeInstalled(provider, TAG);

    await expect(failure).rejects.toThrow('https://ollama.internal:11434.');
    await expect(failure).rejects.not.toThrow('s3cret');
    await expect(failure).rejects.not.toThrow('admin');
  });

  it('fails with the reason when the model list could not be read, not with "not installed"', async () => {
    const provider = providerWith({
      reachable: true,
      version: '0.40.4',
      models: [],
      error: 'Ollama at http://localhost:11434 did not answer within 5000 ms',
    });

    const failure = assertJudgeInstalled(provider, TAG);

    await expect(failure).rejects.toThrow('did not answer within 5000 ms');
    await expect(failure).rejects.not.toThrow('not installed');
  });

  it('says so when Ollama is unreachable and gave no reason', async () => {
    const provider = providerWith({ reachable: false, models: [] });

    await expect(assertJudgeInstalled(provider, TAG)).rejects.toThrow('Ollama is not reachable');
  });
});
