import type { GuardCheckId, GuardVerdict } from './guardVerdict';
import type { Item } from '../domain/schemas';
import type { InputGuard } from './Guard';
import type { GuardsConfig } from '../config/schema';
import type { Logger } from '../shared/telemetry';
import { applyGuards, flaggedBy, planGuards } from './guardRun';

const ALWAYS_BLOCKING: GuardCheckId = 'ruleInjection';

export interface GuardInputDeps {
  /** All available input guards; config decides which run. */
  guards: readonly InputGuard[];
  config: GuardsConfig['input'];
  logger: Logger;
  /** Most items one guard checks at once; GUARD_CONCURRENCY when absent. */
  concurrency?: number;
  /**
   * The run's abort signal: given to every guard call, and no new call starts once it fires. The
   * step then rejects; an aborted call is never a verdict.
   */
  signal?: AbortSignal;
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
  // The rule guard is deterministic, so a hit always blocks, also in mode `all`.
  const toCheck = (guard: InputGuard) => (item: Item) => {
    deps.signal?.throwIfAborted();
    return guard.checkItem(item, { signal: deps.signal });
  };
  const blocking = active.filter((guard) => guard.id === ALWAYS_BLOCKING).map(toCheck);
  const checks = active.filter((guard) => guard.id !== ALWAYS_BLOCKING).map(toCheck);
  const { kept, dropped } = await applyGuards(
    items,
    checks,
    deps.config.mode,
    deps.concurrency,
    blocking,
  );
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
