import type { Draft, GuardCheckId, GuardVerdict, Item } from '../schemas.js';
import type { OutputGuard } from '../../ports/Guard.js';
import type { GuardsConfig } from '../../config/schema.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';

export interface GuardOutputDeps {
  guards: readonly OutputGuard[];
  config: GuardsConfig['output'];
  logger: Logger;
}

export interface GuardOutputOutput {
  passed: Draft[];
  rejected: { draft: Draft; verdicts: GuardVerdict[] }[];
  disabledChecks: GuardCheckId[];
}

/** Runs the output guards on each draft separately (W1-06). */
export function guardOutputStep(
  _drafts: readonly Draft[],
  _sources: readonly Item[],
  _deps: GuardOutputDeps,
): Promise<GuardOutputOutput> {
  throw new NotImplementedError('W1-06');
}
