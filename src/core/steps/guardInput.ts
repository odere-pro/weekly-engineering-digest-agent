import type { GuardCheckId, GuardVerdict, Item } from '../schemas.js';
import type { InputGuard } from '../../ports/Guard.js';
import type { GuardsConfig } from '../../config/schema.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';

export interface GuardInputDeps {
  /** All available input guards; config decides which run. */
  guards: readonly InputGuard[];
  config: GuardsConfig['input'];
  logger: Logger;
}

export interface GuardInputOutput {
  kept: Item[];
  dropped: { item: Item; verdicts: GuardVerdict[] }[];
  /** Checks that were switched off (or missing) this run; named in the digest footer. */
  disabledChecks: GuardCheckId[];
}

/** Runs the input guards on every item (W1-06). */
export function guardInputStep(
  _items: readonly Item[],
  _deps: GuardInputDeps,
): Promise<GuardInputOutput> {
  throw new NotImplementedError('W1-06');
}
