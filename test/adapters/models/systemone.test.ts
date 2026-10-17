import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MIN_STATE_CHARS,
  parseSystemOneResponse,
  questionSize,
  stateBudgetFor,
  toSystemOneQuestions,
  trimState,
  validateQuestions,
} from '../../../src/adapters/models/systemone.js';
import type { DecisionQuestion } from '../../../src/ports/ModelProvider.js';
import { DigestError } from '../../../src/shared/errors.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/ollama/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

/** The port-side twin of test/fixtures/ollama/systemone-request.json. */
const QUESTIONS = {
  hype: {
    type: 'yesno',
    instructions: 'Is this release note mostly marketing hype with no concrete technical change?',
    criteria: { yes: 'mostly hype', no: 'concrete technical change' },
  },
  area: {
    type: 'choice',
    instructions: 'Which engineering area does this release belong to?',
    options: {
      inference: 'model serving and inference',
      training: 'model training',
      platform: null,
    },
  },
  relevance: {
    type: 'score',
    instructions: 'How relevant is this release to an AI platform engineer?',
    levels: ['none', 'low', 'medium', 'high'],
  },
} as const satisfies Record<string, DecisionQuestion>;

function questions(count: number): Record<string, DecisionQuestion> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`q${i}`, { type: 'yesno', instructions: 'Ok?' }]),
  );
}

function scoreAnswer(score: number, probabilities: Record<string, number> = {}): unknown {
  return {
    answers: {
      relevance: { type: 'score', score, probabilities, confidence: 0.5 },
    },
  };
}

describe('toSystemOneQuestions', () => {
  it('maps every port question type to the recorded systemone request shape', () => {
    const recorded = fixture('systemone-request.json') as { questions: unknown };
    expect(toSystemOneQuestions(QUESTIONS)).toEqual(recorded.questions);
  });

  it('omits criteria for a yes/no question without them', () => {
    expect(toSystemOneQuestions({ minor: { type: 'yesno', instructions: 'Minor?' } })).toEqual({
      minor: { type: 'noul', instructions: 'Minor?' },
    });
  });
});

describe('parseSystemOneResponse', () => {
  it('maps the recorded strands-decider answers back to port answers', () => {
    const result = parseSystemOneResponse(fixture('systemone-strands-decider.json'), QUESTIONS);

    expect(result.usage).toEqual({ inputTokens: 335, outputTokens: 0 });
    expect(result.answers.hype).toEqual({ type: 'yesno', probability: 0.056195892590913454 });
    expect(result.answers.area).toEqual({
      type: 'choice',
      choice: 'inference',
      probabilities: {
        inference: 0.9790746891702373,
        training: 0.009239838226941275,
        platform: 0.011685472602821276,
      },
      confidence: 0.8944306234380133,
    });
    const relevance = result.answers.relevance;
    expect(relevance?.type).toBe('score');
    if (relevance?.type !== 'score') return;
    expect(relevance.level).toBeCloseTo(2.038475774181591);
    expect(relevance.score).toBeCloseTo(2.038475774181591 / 3);
    expect(relevance.probabilities).toEqual({
      none: 0.12370353717308609,
      low: 0.1567162505554761,
      medium: 0.27698111318819885,
      high: 0.4425990990832391,
    });
    expect(relevance.confidence).toBe(0.08726628563913486);
  });

  it('maps the recorded clef answers back to port answers', () => {
    const result = parseSystemOneResponse(fixture('systemone-clef.json'), QUESTIONS);

    expect(result.usage).toEqual({ inputTokens: 359, outputTokens: 0 });
    expect(result.answers.hype).toEqual({ type: 'yesno', probability: 0.023689471299374428 });
    expect(result.answers.area).toMatchObject({ type: 'choice', choice: 'inference' });
    expect(result.answers.relevance).toMatchObject({
      type: 'score',
      level: 2.7116717645265753,
      probabilities: { high: 0.7869526838635142 },
    });
  });

  it('maps the recorded yes/no answer without criteria', () => {
    const result = parseSystemOneResponse(fixture('systemone-yesno-no-criteria.json'), {
      minor: { type: 'yesno', instructions: 'Is this a minor release?' },
    });
    expect(result.answers).toEqual({ minor: { type: 'yesno', probability: 0.695535898078412 } });
  });

  it('defaults usage to zero when the response has none', () => {
    const result = parseSystemOneResponse(scoreAnswer(1), {
      relevance: QUESTIONS.relevance,
    });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('clamps an out-of-range score to the level range', () => {
    const high = parseSystemOneResponse(scoreAnswer(7), { relevance: QUESTIONS.relevance });
    const low = parseSystemOneResponse(scoreAnswer(-1), { relevance: QUESTIONS.relevance });
    expect(high.answers.relevance).toMatchObject({ level: 3, score: 1 });
    expect(low.answers.relevance).toMatchObject({ level: 0, score: 0 });
  });

  it('gives a level without a probability zero', () => {
    const result = parseSystemOneResponse(scoreAnswer(1, { '1': 1 }), {
      relevance: QUESTIONS.relevance,
    });
    expect(result.answers.relevance).toMatchObject({
      probabilities: { none: 0, low: 1, medium: 0, high: 0 },
    });
  });

  it('rejects score probabilities that are not keyed by level index', () => {
    expect(() =>
      parseSystemOneResponse(scoreAnswer(1, { low: 1 }), { relevance: QUESTIONS.relevance }),
    ).toThrow('has a score probability for "low", not a level index');
  });

  it('rejects a probability outside 0..1', () => {
    expect(() =>
      parseSystemOneResponse(
        { answers: { minor: { type: 'noul', noul: 1.5 } } },
        { minor: { type: 'yesno', instructions: 'x' } },
      ),
    ).toThrow(/unexpected \/v1\/systemone response/);
  });

  it('rejects a response that does not match the systemone shape', () => {
    expect(() =>
      parseSystemOneResponse({ answers: { hype: { type: 'noul' } } }, QUESTIONS),
    ).toThrow(/unexpected \/v1\/systemone response/);
  });

  it('rejects a response without an answer for a question', () => {
    expect(() =>
      parseSystemOneResponse({ answers: {} }, { minor: { type: 'yesno', instructions: 'x' } }),
    ).toThrow('no answer for question "minor"');
  });

  it('rejects an answer of the wrong type', () => {
    const raw = { answers: { relevance: { type: 'noul', noul: 0.5 } } };
    expect(() => parseSystemOneResponse(raw, { relevance: QUESTIONS.relevance })).toThrow(
      'answered question "relevance" (score) with type noul',
    );
  });

  it('rejects a choice that is not one of the options', () => {
    const raw = {
      answers: {
        area: { type: 'choice', choice: 'security', probabilities: {}, confidence: 1 },
      },
    };
    expect(() => parseSystemOneResponse(raw, { area: QUESTIONS.area })).toThrow(
      'chose "security", which is not an option',
    );
  });
});

describe('validateQuestions', () => {
  it('accepts 1 to 64 questions', () => {
    expect(() => {
      validateQuestions(questions(1));
    }).not.toThrow();
    expect(() => {
      validateQuestions(questions(64));
    }).not.toThrow();
  });

  it('rejects 65 questions and none', () => {
    expect(() => {
      validateQuestions(questions(65));
    }).toThrow('decide needs 1-64 questions, got 65');
    expect(() => {
      validateQuestions({});
    }).toThrow('decide needs 1-64 questions, got 0');
  });

  it('rejects 11 score levels and 1 score level', () => {
    const levels = (n: number): string[] => Array.from({ length: n }, (_, i) => `l${i}`);
    expect(() => {
      validateQuestions({ s: { type: 'score', instructions: 'x', levels: levels(11) } });
    }).toThrow('question "s" has 11 score levels; 2-10 are allowed');
    expect(() => {
      validateQuestions({ s: { type: 'score', instructions: 'x', levels: levels(1) } });
    }).toThrow('question "s" has 1 score levels; 2-10 are allowed');
  });

  it('rejects duplicate score levels', () => {
    expect(() => {
      validateQuestions({ s: { type: 'score', instructions: 'x', levels: ['low', 'low'] } });
    }).toThrow('question "s" has duplicate score levels');
  });

  it('rejects 1 choice option and 27 choice options', () => {
    const options = (n: number): Record<string, null> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
    expect(() => {
      validateQuestions({ c: { type: 'choice', instructions: 'x', options: options(1) } });
    }).toThrow('question "c" has 1 choice options; 2-26 are allowed');
    expect(() => {
      validateQuestions({ c: { type: 'choice', instructions: 'x', options: options(27) } });
    }).toThrow('question "c" has 27 choice options; 2-26 are allowed');
  });

  it('throws a DigestError', () => {
    expect(() => {
      validateQuestions({});
    }).toThrow(DigestError);
  });
});

describe('state budget', () => {
  it('gives strands-decider 10 000 chars and every other model 48 000', () => {
    expect(stateBudgetFor('strands-decider:2b-mlx-bf16')).toBe(10_000);
    expect(stateBudgetFor('strands-decider')).toBe(10_000);
    expect(stateBudgetFor('someone/strands-decider:latest')).toBe(10_000);
    expect(stateBudgetFor('strands-deciderx:latest')).toBe(48_000);
    expect(stateBudgetFor('clef:latest')).toBe(48_000);
  });

  it('takes the size of the questions out of the budget, which is a context shared with the state', () => {
    expect(stateBudgetFor('strands-decider:2b-mlx-bf16', 1_500)).toBe(8_500);
    expect(stateBudgetFor('clef:latest', 1_500)).toBe(46_500);
  });

  it('never leaves less than the minimum for the state, however large the questions are', () => {
    expect(stateBudgetFor('strands-decider:2b-mlx-bf16', 9_500)).toBe(MIN_STATE_CHARS);
    expect(stateBudgetFor('strands-decider:2b-mlx-bf16', 50_000)).toBe(MIN_STATE_CHARS);
    expect(stateBudgetFor('clef:latest', 100_000)).toBe(MIN_STATE_CHARS);
  });

  it('leaves a state within budget unchanged', () => {
    expect(trimState('short', 10)).toBe('short');
  });

  it('trims to the budget, keeping the head and the closing tail', () => {
    const state = `<<<DATA item>>>\n${'a'.repeat(20_000)}\n<<<END DATA>>>`;
    const trimmed = trimState(state, 10_000);
    expect(trimmed).toHaveLength(10_000);
    expect(trimmed.startsWith('<<<DATA item>>>')).toBe(true);
    expect(trimmed.endsWith('\n<<<END DATA>>>')).toBe(true);
    expect(trimmed).toContain('[... trimmed ...]');
  });

  it('never splits a surrogate pair at either cut', () => {
    const trimmed = trimState('😀'.repeat(10_000), 1_000);
    expect(trimmed.length).toBeLessThanOrEqual(1_000);
    // encodeURIComponent throws on a lone surrogate.
    expect(() => encodeURIComponent(trimmed)).not.toThrow();
  });
});

describe('questionSize', () => {
  it('counts the characters of the questions as they are sent', () => {
    const sent = toSystemOneQuestions({ a: { type: 'yesno', instructions: 'abc' } });

    expect(questionSize(sent)).toBe('{"a":{"type":"noul","instructions":"abc"}}'.length);
  });

  it('grows with the options of a choice question', () => {
    const few = toSystemOneQuestions({
      q: { type: 'choice', instructions: 'Which?', options: { a: 'one', b: 'two' } },
    });
    const many = toSystemOneQuestions({
      q: {
        type: 'choice',
        instructions: 'Which?',
        options: { a: 'one', b: 'two', c: 'a long description of the third option' },
      },
    });

    expect(questionSize(many)).toBeGreaterThan(questionSize(few));
  });
});
