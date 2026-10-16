import type { InputGuard, OutputGuard } from '../../ports/Guard.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface GraniteGuardOptions {
  /** Calls generate() with role "guardRisk". */
  model: ModelProvider;
}

/** Input guard: granite4.1-guardian trained risks (jailbreak, harm) (W1-05). */
export function createGraniteRiskGuard(_options: GraniteGuardOptions): InputGuard {
  throw new NotImplementedError('W1-05');
}

/** Output guard: each digest item grounded in its source item (W1-05). */
export function createGraniteGroundednessGuard(_options: GraniteGuardOptions): OutputGuard {
  throw new NotImplementedError('W1-05');
}
