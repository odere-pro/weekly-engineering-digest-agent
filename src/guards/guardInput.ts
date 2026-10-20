import type { GuardCheckId, GuardVerdict } from './guardVerdict';
import type { Item } from '../domain/schemas';
import type { InputGuard } from './Guard';
import type { GuardsConfig } from '../config/schema';
import type { Clock } from '../shared/clock';
import type { Logger } from '../shared/telemetry';
import { applyGuards, flaggedBy, passProgress } from './guardRun';
import { checkWith, planInputGuards } from './inputGuardPlan';

export interface GuardInputDeps {
  /** All available input guards; config decides which run. */
  guards: readonly InputGuard[];
  /**
   * Whether the model guards run here too. false: only the rule guard runs, and the model guards
   * check the ranked candidates after `process` (`guardCandidatesStep`). true when absent.
   */
  modelGuards?: boolean;
  config: GuardsConfig['input'];
  logger: Logger;
  /** Times the `Progress` lines; the system clock when absent. */
  clock?: Clock;
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

/** Runs the input guards on every item (W1-06); with `modelGuards: false`, the rule guard only. */
export async function guardInputStep(
  items: readonly Item[],
  deps: GuardInputDeps,
): Promise<GuardInputOutput> {
  const planned = planInputGuards(deps);
  const { disabledChecks } = planned;
  // The rule guard is deterministic, so a hit always blocks, also in mode `all`.
  const toCheck = (guard: InputGuard) => checkWith(guard, deps.signal);
  const blocking = planned.blocking.map(toCheck);
  const modelGuards = deps.modelGuards === false ? [] : planned.models;
  const { kept, dropped } = await applyGuards(
    items,
    modelGuards.map(toCheck),
    deps.config.mode,
    deps.concurrency,
    blocking,
    passProgress(
      modelGuards.map((guard) => guard.id),
      deps.logger,
      deps.clock,
    ),
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
