import { QUESTION_IDS } from '../../../src/classify/classifyPrompt';
import { JUDGE_CRITERIA } from '../../../src/select/judgePrompt';
import type { Item } from '../../../src/domain/schemas';
import type { DecideRequest, DecisionAnswer } from '../../../src/models/ModelProvider';
import { MODELS_AREA, PLATFORM_AREA } from './constants';
import { itemsIn } from './feedItems';

const RELEVANT = 2.4;

const relevantAnswer: DecisionAnswer = {
  type: 'score',
  level: RELEVANT,
  score: 0.8,
  probabilities: {},
  confidence: 0.9,
};
/** Below the default relevance threshold of 1.5. */
export const IRRELEVANT_ANSWER: DecisionAnswer = {
  type: 'score',
  level: 0.2,
  score: 0.07,
  probabilities: {},
  confidence: 0.9,
};

/** Decision model: the patch release is minor, everything else is relevant and calm. */
export function defaultAnswers(
  items: readonly Item[],
  request: DecideRequest,
): Record<string, DecisionAnswer> {
  if (request.role === 'judge') {
    return Object.fromEntries(JUDGE_CRITERIA.map((criterion) => [criterion, relevantAnswer]));
  }
  const [item] = itemsIn(items, request.state);
  const area = item?.kind === 'github' ? PLATFORM_AREA : MODELS_AREA;
  return {
    [QUESTION_IDS.relevance]: relevantAnswer,
    [QUESTION_IDS.area]: { type: 'choice', choice: area, probabilities: {}, confidence: 0.85 },
    [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.05 },
    [QUESTION_IDS.minorRelease]: {
      type: 'yesno',
      probability: item?.title.endsWith('.1') ? 0.9 : 0.1,
    },
  };
}
