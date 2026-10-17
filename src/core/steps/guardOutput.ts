import type { Draft, GuardCheckId, GuardVerdict, Item } from '../schemas.js';
import type { OutputGuard } from '../../ports/Guard.js';
import type { GuardsConfig } from '../../config/schema.js';
import type { Logger } from '../../shared/telemetry.js';
import { applyGuards, flaggedBy, planGuards } from './guardRun.js';

export interface GuardOutputDeps {
  guards: readonly OutputGuard[];
  config: GuardsConfig['output'];
  logger: Logger;
  /** Most drafts one guard checks at once; GUARD_CONCURRENCY when absent. */
  concurrency?: number;
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
  const checks = active.map((guard) => (draft: Draft) => guard.checkDraft(draft, sources));
  const { kept, dropped } = await applyGuards(drafts, checks, deps.config.mode, deps.concurrency);
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
