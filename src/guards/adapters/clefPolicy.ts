import type { Draft, Item, StepName } from '../../domain/schemas';
import type { GuardCheckId, GuardVerdict } from '../guardVerdict';
import {
  policyQuestions,
  policyState,
  rubricQuestions,
  rubricState,
  type GuardQuestion,
} from '../guardQuestions';
import type { GuardCallOptions, InputGuard, OutputGuard } from '../Guard';
import type { DecisionAnswer, ModelProvider } from '../../models/ModelProvider';
import { DigestError } from '../../shared/errors';

export interface DecisionGuardOptions {
  /** Calls decide() with role "guardPolicy". */
  model: ModelProvider;
  /** Flag when P(yes) is above this (config.thresholds.guardFlag). */
  flagThreshold: number;
  /** The config's focus areas, named in the rubric guard's off-task question. */
  focusAreas?: readonly string[];
}

/** Input guard: this agent's own questions (instructions aimed at an AI, harmful content) (W1-05). */
export function createClefPolicyGuard(options: DecisionGuardOptions): InputGuard {
  assertThreshold(options.flagThreshold);
  const questions = policyQuestions();
  return {
    id: 'clefPolicy',
    checkItem: (item: Item, callOptions?: GuardCallOptions) =>
      askQuestions(options, {
        check: 'clefPolicy',
        step: 'guardInput',
        questions,
        state: policyState(item),
        signal: callOptions?.signal,
      }),
  };
}

/** Output guard: off-task, hype and harmful-content questions on each draft (W1-05). */
export function createClefRubricGuard(options: DecisionGuardOptions): OutputGuard {
  assertThreshold(options.flagThreshold);
  const questions = rubricQuestions(options.focusAreas);
  return {
    id: 'clefRubric',
    checkDraft: (draft: Draft, _sources: readonly Item[], callOptions?: GuardCallOptions) =>
      askQuestions(options, {
        check: 'clefRubric',
        step: 'guardOutput',
        questions,
        state: rubricState(draft),
        signal: callOptions?.signal,
      }),
  };
}

/** A NaN threshold would never flag anything, so it fails when the guard is created. */
function assertThreshold(flagThreshold: number): void {
  if (flagThreshold >= 0 && flagThreshold <= 1) return;
  throw new DigestError(`clef guard: flagThreshold must be between 0 and 1, got ${flagThreshold}`);
}

interface Ask {
  check: GuardCheckId;
  step: StepName;
  questions: readonly GuardQuestion[];
  state: string;
  signal: AbortSignal | undefined;
}

/** One decide() call. Flags when any P(yes) is above the threshold; probability is the maximum. */
async function askQuestions(options: DecisionGuardOptions, ask: Ask): Promise<GuardVerdict> {
  const { answers } = await options.model.decide({
    role: 'guardPolicy',
    state: ask.state,
    questions: Object.fromEntries(ask.questions.map(({ id, question }) => [id, question])),
    ...(ask.signal ? { signal: ask.signal } : {}),
  });
  const scored = ask.questions.map(({ id, label }) => ({
    label,
    probability: probabilityOf(answers, id, ask),
  }));
  const probability = Math.max(...scored.map((entry) => entry.probability));
  const over = scored.filter((entry) => entry.probability > options.flagThreshold);
  if (over.length === 0) return { check: ask.check, flagged: false, probability };
  const reason = over.map((e) => `${e.label} (${e.probability.toFixed(3)})`).join('; ');
  return { check: ask.check, flagged: true, probability, reason };
}

/** A missing or malformed answer is an error, never a pass. */
function probabilityOf(
  answers: Readonly<Record<string, DecisionAnswer>>,
  questionId: string,
  ask: Ask,
): number {
  const answer = answers[questionId];
  if (answer?.type === 'yesno' && answer.probability >= 0 && answer.probability <= 1)
    return answer.probability;
  const got =
    answer?.type === 'yesno' ? `probability ${answer.probability}` : (answer?.type ?? 'none');
  throw new DigestError(
    `${ask.check}: expected a yes/no probability between 0 and 1 for "${questionId}", got ${got}`,
    { step: ask.step },
  );
}
