import { WEEK_ID_PATTERN } from '../../domain/schemas';
import type { GuardCheckId } from '../../guards/guardVerdict';
import { planGuards } from '../../guards/guardRun';
import { DigestError } from '../../shared/errors';
import { isoWeekId } from '../../shared/isoWeek';
import { noopLogger, type Logger } from '../../shared/telemetry';
import type { DigestDeps, RunOptions } from '../types';

/** One run's fixed inputs, resolved before anything runs. */
export interface RunContext {
  readonly deps: DigestDeps;
  readonly weekId: string;
  readonly dryRun: boolean;
  readonly sinceDays: number;
  readonly startedAt: Date;
  readonly signal?: AbortSignal;
  /** See `RunOptions.notifyFailure`. */
  readonly notifyFailure: boolean;
  /** See `RunOptions.noFallback`. */
  readonly useFallback: boolean;
  /** Bound to the run id. */
  readonly logger: Logger;
  /** Input then output checks that are off this run, in config order. */
  readonly disabledGuards: readonly GuardCheckId[];
  /**
   * The week's earlier record reached a channel, and the files it left are what a resume sends.
   * This run then holds its files in the chain state; `endRun` writes them if its record is saved.
   */
  readonly holdArtifacts: boolean;
}

/** Resolves the options against the config and the clock; throws on a bad week id or window. */
export function runContext(deps: DigestDeps, options: RunOptions): RunContext {
  const startedAt = deps.clock.now();
  const weekId = options.weekId ?? isoWeekId(startedAt, deps.config.schedule.timeZone);
  const sinceDays = options.sinceDays ?? deps.config.windowDays;
  if (!WEEK_ID_PATTERN.test(weekId)) {
    throw new DigestError(`Invalid ISO week id "${weekId}"; expected one like 2026-W43`);
  }
  if (!Number.isInteger(sinceDays) || sinceDays < 1) {
    throw new DigestError(
      `The window must be a whole number of days, at least 1; got ${sinceDays}`,
    );
  }
  return {
    deps,
    weekId,
    startedAt,
    sinceDays,
    dryRun: options.dryRun ?? false,
    signal: options.signal,
    notifyFailure: options.notifyFailure ?? true,
    useFallback: options.noFallback !== true,
    logger: deps.logger.child({ runId: weekId }),
    disabledGuards: plannedDisabledGuards(deps),
    holdArtifacts: false,
  };
}

/**
 * Output guards run after the code checks, yet the footer those checks see must already name
 * them. The guard steps plan the same way and log missing guards themselves, so this is silent.
 */
function plannedDisabledGuards(deps: DigestDeps): GuardCheckId[] {
  const { input, output } = deps.config.guards;
  return [
    ...planGuards(input, deps.inputGuards, noopLogger).disabledChecks,
    ...planGuards(output, deps.outputGuards, noopLogger).disabledChecks,
  ];
}
