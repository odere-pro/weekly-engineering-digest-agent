import type { GuardCheckId, GuardVerdict, Item } from '../schemas.js';
import type { InputGuard } from '../../ports/Guard.js';
import type { GuardsConfig } from '../../config/schema.js';
import type { Logger } from '../../shared/telemetry.js';
import { applyGuards, flaggedBy, planGuards } from './guardRun.js';

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
export async function guardInputStep(
  items: readonly Item[],
  deps: GuardInputDeps,
): Promise<GuardInputOutput> {
  const { active, disabledChecks } = planGuards(deps.config, deps.guards, deps.logger);
  const checks = active.map((guard) => (item: Item) => guard.checkItem(item));
  const { kept, dropped } = await applyGuards(items, checks, deps.config.mode);
  for (const { subject, verdicts } of dropped) {
    deps.logger.debug('input guards dropped item', {
      itemId: subject.id,
      flaggedBy: flaggedBy(verdicts),
    });
  }
  return {
    kept,
    dropped: dropped.map(({ subject, verdicts }) => ({ item: subject, verdicts })),
    disabledChecks,
  };
}
