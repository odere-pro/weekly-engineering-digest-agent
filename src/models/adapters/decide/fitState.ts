import type { Logger } from '../../../shared/telemetry';
import type { Role } from '../../roles';
import { questionSize, stateBudgetFor, trimState, type SystemOneQuestion } from '../systemone';

/** Trims `state` to what is left of the model's context after the questions; logs a cut. */
export function fitState(
  logger: Logger,
  spec: { role: Role; model: string },
  state: string,
  questions: Readonly<Record<string, SystemOneQuestion>>,
): string {
  const questionChars = questionSize(questions);
  const trimmed = trimState(state, stateBudgetFor(spec.model, questionChars));
  if (trimmed !== state)
    logger.child(spec).warn('decide state trimmed', {
      fromChars: state.length,
      toChars: trimmed.length,
      questionChars,
    });
  return trimmed;
}
