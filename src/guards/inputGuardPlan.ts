import type { Item } from '../domain/schemas';
import type { GuardsConfig } from '../config/schema';
import type { Logger } from '../shared/telemetry';
import type { InputGuard } from './Guard';
import { planGuards } from './guardRun';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';

/** The deterministic rule guard: a hit always blocks, also in mode `all`. */
const ALWAYS_BLOCKING: GuardCheckId = 'ruleInjection';

interface InputGuardPlan {
  /** The rule guard, when on: run on every collected item first. */
  blocking: InputGuard[];
  /** The model guards (clefPolicy, graniteRisk), when on, in config order. */
  models: InputGuard[];
  /** Checks switched off or missing; named in the digest footer. */
  disabledChecks: GuardCheckId[];
}

/** The enabled input guards, split into the rule guard and the model guards. */
export function planInputGuards(deps: {
  guards: readonly InputGuard[];
  config: GuardsConfig['input'];
  logger: Logger;
}): InputGuardPlan {
  const { active, disabledChecks } = planGuards(deps.config, deps.guards, deps.logger);
  return {
    blocking: active.filter((guard) => guard.id === ALWAYS_BLOCKING),
    models: active.filter((guard) => guard.id !== ALWAYS_BLOCKING),
    disabledChecks,
  };
}

/** One guard as a check function: no new call once the run's signal has fired. */
export function checkWith(
  guard: InputGuard,
  signal: AbortSignal | undefined,
): (item: Item) => Promise<GuardVerdict> {
  return (item) => {
    signal?.throwIfAborted();
    return guard.checkItem(item, { signal });
  };
}
