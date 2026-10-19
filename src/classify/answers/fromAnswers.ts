import { z } from 'zod';
import { classifyError } from './classifyError';
import { ClassificationSchema, type Classification } from '../classification';
import { QUESTION_IDS } from '../classifyPrompt';
import type { DecisionAnswer } from '../../models/ModelProvider';

type AnswerOf<T extends DecisionAnswer['type']> = Extract<DecisionAnswer, { type: T }>;

/**
 * Turns the four decision answers for one item into a `Classification`: the expected level as
 * relevance, the area's confidence, and the two yes probabilities. Throws a `DigestError` for a
 * missing or wrongly typed answer, an area that is not an option, or a value out of range.
 */
export function fromAnswers(
  itemId: string,
  answers: Readonly<Record<string, DecisionAnswer>>,
  areas: ReadonlySet<string>,
): Classification {
  const relevance = answerOf(answers, QUESTION_IDS.relevance, 'score', itemId);
  const area = answerOf(answers, QUESTION_IDS.area, 'choice', itemId);
  const hype = answerOf(answers, QUESTION_IDS.hype, 'yesno', itemId);
  const minorRelease = answerOf(answers, QUESTION_IDS.minorRelease, 'yesno', itemId);
  if (!areas.has(area.choice))
    throw classifyError(`chose area "${area.choice}" for item ${itemId}, which is not an option`);
  return validated({
    itemId,
    relevance: relevance.level,
    area: area.choice,
    areaConfidence: area.confidence,
    hype: hype.probability,
    minorRelease: minorRelease.probability,
  });
}

function answerOf<T extends DecisionAnswer['type']>(
  answers: Readonly<Record<string, DecisionAnswer>>,
  questionId: string,
  type: T,
  itemId: string,
): AnswerOf<T> {
  const answer = answers[questionId];
  if (answer?.type !== type)
    throw classifyError(
      `expected a ${type} answer to "${questionId}" for item ${itemId}, got ${answer?.type ?? 'none'}`,
    );
  return answer as AnswerOf<T>;
}

function validated(classification: Classification): Classification {
  const parsed = ClassificationSchema.safeParse(classification);
  if (parsed.success) return parsed.data;
  throw classifyError(
    `invalid answers for item ${classification.itemId}: ${z.prettifyError(parsed.error)}`,
  );
}
