import type { Draft, Item } from '../domain/schemas';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';
import type { OutputGuard } from './Guard';
import type { GuardsConfig } from '../config/schema';
import type { Clock } from '../shared/clock';
import type { Logger } from '../shared/telemetry';
import { applyGuards, flaggedBy, passProgress, planGuards } from './guardRun';

export interface GuardOutputDeps {
  guards: readonly OutputGuard[];
  config: GuardsConfig['output'];
  logger: Logger;
  /** Times the `Progress` lines; the system clock when absent. */
  clock?: Clock;
  /** Most drafts one guard checks at once; GUARD_CONCURRENCY when absent. */
  concurrency?: number;
  /**
   * The run's abort signal: given to every guard call, and no new call starts once it fires. The
   * step then rejects; an aborted call is never a verdict.
   */
  signal?: AbortSignal;
}

export interface GuardOutputOutput {
  passed: Draft[];
  rejected: { draft: Draft; verdicts: GuardVerdict[] }[];
  disabledChecks: GuardCheckId[];
}

/** Runs the output guards on each draft separately (W1-06). */
export async function guardOutputStep(
  drafts: readonly Draft[],
  sources: readonly Item[],
  deps: GuardOutputDeps,
): Promise<GuardOutputOutput> {
  const { active, disabledChecks } = planGuards(deps.config, deps.guards, deps.logger);
  const checks = active.map((guard) => (draft: Draft) => {
    deps.signal?.throwIfAborted();
    return guard.checkDraft(draft, sources, { signal: deps.signal });
  });
  const { kept, dropped } = await applyGuards(
    drafts,
    checks,
    deps.config.mode,
    deps.concurrency,
    [],
    passProgress(
      active.map((guard) => guard.id),
      deps.logger,
      deps.clock,
    ),
  );
  for (const { subject, verdicts } of dropped) {
    deps.logger.debug('output guards rejected draft', {
      writer: subject.writer,
      flaggedBy: flaggedBy(verdicts),
    });
  }
  return {
    passed: kept,
    rejected: dropped.map(({ subject, verdicts }) => ({ draft: subject, verdicts })),
    disabledChecks,
  };
}
