import type { InputGuard, OutputGuard } from '../../ports/Guard.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface DecisionGuardOptions {
  /** Calls decide() with role "guardPolicy". */
  model: ModelProvider;
  /** Flag when P(yes) is above this (config.thresholds.guardFlag). */
  flagThreshold: number;
}

/** Input guard: this agent's own questions (instructions aimed at an AI, harmful content) (W1-05). */
export function createClefPolicyGuard(_options: DecisionGuardOptions): InputGuard {
  throw new NotImplementedError('W1-05');
}

/** Output guard: off-task, hype and harmful-content questions on each draft (W1-05). */
export function createClefRubricGuard(_options: DecisionGuardOptions): OutputGuard {
  throw new NotImplementedError('W1-05');
}
