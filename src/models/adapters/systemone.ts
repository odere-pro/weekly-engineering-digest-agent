// Mapping between the ModelProvider decision types and Ollama's /v1/systemone endpoint
// (shapes recorded from Ollama 0.40.4 in src/models/adapters/__fixtures__/ollama).
import { z } from 'zod';
import type { DecisionAnswer, DecisionQuestion, Usage } from '../ModelProvider';
import { DigestError } from '../../shared/errors';
import { parseOllamaResponse } from './ollamaHttp';

const QUESTION_LIMITS = { min: 1, max: 64 } as const;
const CHOICE_OPTION_LIMITS = { min: 2, max: 26 } as const;
const SCORE_LEVEL_LIMITS = { min: 2, max: 10 } as const;

/**
 * strands-decider (any namespace) has a 4K context; every other decision model gets more. The
 * budgets are for the questions and the state together (see `stateBudgetFor`).
 */
const SMALL_CONTEXT_MODEL = /(?:^|\/)strands-decider(?::|$)/;
const SMALL_CONTEXT_STATE_CHARS = 10_000;
const DEFAULT_STATE_CHARS = 48_000;
/** Least state a decide call keeps, however much room the questions take. */
export const MIN_STATE_CHARS = 1_000;
/** Share of a trimmed state kept from the end, so a closing data marker survives. */
const TRIM_TAIL_SHARE = 0.1;
const TRIM_MARKER = '\n[... trimmed ...]\n';

export type SystemOneQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

const Probability = z.number().min(0).max(1);
const ProbabilitiesSchema = z.record(z.string(), Probability);

const AnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: Probability }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: ProbabilitiesSchema,
    confidence: Probability,
  }),
  z.object({
    type: z.literal('score'),
    /** Expected level index (0 = first level), not 0..1. */
    score: z.number(),
    /** Keyed by level index: "0", "1", ... */
    probabilities: ProbabilitiesSchema,
    confidence: Probability,
  }),
]);
type SystemOneAnswer = z.infer<typeof AnswerSchema>;

const ResponseSchema = z.object({
  answers: z.record(z.string(), AnswerSchema),
  usage: z
    .object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) })
    .optional(),
});

function checkCount(
  id: string,
  what: string,
  count: number,
  limits: { min: number; max: number },
): void {
  if (count < limits.min || count > limits.max)
    throw new DigestError(
      `decide question "${id}" has ${count} ${what}; ${limits.min}-${limits.max} are allowed`,
    );
}

function validateQuestion(id: string, question: DecisionQuestion): void {
  if (question.type === 'choice')
    checkCount(id, 'choice options', Object.keys(question.options).length, CHOICE_OPTION_LIMITS);
  if (question.type !== 'score') return;
  checkCount(id, 'score levels', question.levels.length, SCORE_LEVEL_LIMITS);
  if (new Set(question.levels).size !== question.levels.length)
    throw new DigestError(`decide question "${id}" has duplicate score levels`);
}

/** Throws a DigestError unless there are 1-64 questions, 2-26 options and 2-10 unique levels. */
export function validateQuestions(questions: Readonly<Record<string, DecisionQuestion>>): void {
  const count = Object.keys(questions).length;
  if (count < QUESTION_LIMITS.min || count > QUESTION_LIMITS.max)
    throw new DigestError(
      `decide needs ${QUESTION_LIMITS.min}-${QUESTION_LIMITS.max} questions, got ${count}`,
    );
  for (const [id, question] of Object.entries(questions)) validateQuestion(id, question);
}

function toSystemOneQuestion(question: DecisionQuestion): SystemOneQuestion {
  const { instructions } = question;
  switch (question.type) {
    case 'yesno':
      return question.criteria
        ? {
            type: 'noul',
            instructions,
            criteria: { true: question.criteria.yes, false: question.criteria.no },
          }
        : { type: 'noul', instructions };
    case 'choice':
      return { type: 'choice', instructions, criteria: { ...question.options } };
    case 'score':
      return { type: 'score', instructions, criteria: [...question.levels] };
  }
}

/** yesno -> noul (criteria yes/no -> "true"/"false"), choice options -> criteria object, score levels -> criteria array. */
export function toSystemOneQuestions(
  questions: Readonly<Record<string, DecisionQuestion>>,
): Record<string, SystemOneQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, toSystemOneQuestion(question)]),
  );
}

function toChoiceAnswer(
  id: string,
  question: Extract<DecisionQuestion, { type: 'choice' }>,
  answer: Extract<SystemOneAnswer, { type: 'choice' }>,
): DecisionAnswer {
  if (!Object.hasOwn(question.options, answer.choice))
    throw new DigestError(
      `systemone question "${id}" chose "${answer.choice}", which is not an option`,
    );
  return {
    type: 'choice',
    choice: answer.choice,
    probabilities: { ...answer.probabilities },
    confidence: answer.confidence,
  };
}

/** Score answers come keyed by level index; the port keys them by level name. */
function toScoreAnswer(
  id: string,
  question: Extract<DecisionQuestion, { type: 'score' }>,
  answer: Extract<SystemOneAnswer, { type: 'score' }>,
): DecisionAnswer {
  const indexKeys = new Set(question.levels.map((_, index) => String(index)));
  const unknownKey = Object.keys(answer.probabilities).find((key) => !indexKeys.has(key));
  if (unknownKey !== undefined)
    throw new DigestError(
      `systemone question "${id}" has a score probability for "${unknownKey}", not a level index`,
    );
  const maxLevel = question.levels.length - 1;
  const level = Math.min(Math.max(answer.score, 0), maxLevel);
  const probabilities = Object.fromEntries(
    question.levels.map((name, index) => [name, answer.probabilities[String(index)] ?? 0]),
  );
  return {
    type: 'score',
    level,
    score: level / maxLevel,
    probabilities,
    confidence: answer.confidence,
  };
}

function toDecisionAnswer(
  id: string,
  question: DecisionQuestion,
  answer: SystemOneAnswer | undefined,
): DecisionAnswer {
  if (!answer) throw new DigestError(`systemone returned no answer for question "${id}"`);
  if (question.type === 'yesno' && answer.type === 'noul')
    return { type: 'yesno', probability: answer.noul };
  if (question.type === 'choice' && answer.type === 'choice')
    return toChoiceAnswer(id, question, answer);
  if (question.type === 'score' && answer.type === 'score')
    return toScoreAnswer(id, question, answer);
  throw new DigestError(
    `systemone answered question "${id}" (${question.type}) with type ${answer.type}`,
  );
}

/** Validates a /v1/systemone response and maps it to port answers for `questions`. */
export function parseSystemOneResponse(
  raw: unknown,
  questions: Readonly<Record<string, DecisionQuestion>>,
): { answers: Record<string, DecisionAnswer>; usage: Usage } {
  const { answers, usage } = parseOllamaResponse(ResponseSchema, raw, '/v1/systemone');
  return {
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        toDecisionAnswer(id, question, answers[id]),
      ]),
    ),
    usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 },
  };
}

/** Characters of the questions as they go over the wire (they share the context with the state). */
export function questionSize(questions: Readonly<Record<string, SystemOneQuestion>>): number {
  return JSON.stringify(questions).length;
}

/**
 * Character budget for the `state` text of a decision model: the model's budget less the room the
 * questions take, never below MIN_STATE_CHARS (a state cut to nothing would be answered blind).
 */
export function stateBudgetFor(model: string, questionChars = 0): number {
  const budget = SMALL_CONTEXT_MODEL.test(model) ? SMALL_CONTEXT_STATE_CHARS : DEFAULT_STATE_CHARS;
  return Math.max(budget - questionChars, MIN_STATE_CHARS);
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Cuts `state` to at most `budget` chars, keeping the head and a short tail around a trim
 * marker, without splitting a surrogate pair.
 */
export function trimState(state: string, budget: number): string {
  if (state.length <= budget) return state;
  const room = budget - TRIM_MARKER.length;
  const tailLength = Math.floor(room * TRIM_TAIL_SHARE);
  const headEnd = room - tailLength;
  const tailStart = state.length - tailLength;
  const head = state.slice(0, isLowSurrogate(state, headEnd) ? headEnd - 1 : headEnd);
  const tail = state.slice(isLowSurrogate(state, tailStart) ? tailStart + 1 : tailStart);
  return `${head}${TRIM_MARKER}${tail}`;
}
