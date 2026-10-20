import { WEEK_ID_PATTERN } from '../../domain/schemas';
import type { GuardCheckId } from '../../guards/guardVerdict';
import { planGuards } from '../../guards/guardRun';
import { DigestError } from '../../shared/errors';
import { isoWeekId } from '../../shared/isoWeek';
import { noopLogger, type Logger } from '../../shared/telemetry';
import type { RunRecord } from '../../store/runRecord';
import type { DigestDeps, RunOptions } from '../types';
import type { RunVariant } from '../variant';

/** One run's fixed inputs, resolved before anything runs. */
export interface RunContext {
  readonly deps: DigestDeps;
  readonly weekId: string;
  readonly dryRun: boolean;
  readonly sinceDays: number;
  readonly startedAt: Date;
  /** The caller's signal (`RunOptions.signal`) and, once the run holds the lock, its `lost` too. */
  readonly signal?: AbortSignal;
  /**
   * The lock's `lost` (`RunLock`), once the run holds it: fired, the week belongs to the run that
   * took the lock over, so this one writes no file and `endRun` saves nothing. See `holdingLock`.
   */
  readonly lockLost?: AbortSignal;
  /** See `RunOptions.notifyFailure`. */
  readonly notifyFailure: boolean;
  /** See `RunOptions.noFallback`. */
  readonly useFallback: boolean;
  /** See `RunOptions.reuse`. */
  readonly reuse?: RunOptions['reuse'];
  /** See `RunOptions.variant`. */
  readonly variant?: RunVariant;
  /** Bound to the run id. */
  readonly logger: Logger;
  /** Input then output checks that are off this run, in config order. */
  readonly disabledGuards: readonly GuardCheckId[];
  /**
   * The week's earlier record reached a channel, and the files it left are what a resume sends.
   * This run then holds its files in the chain state; `endRun` writes them if its record is saved.
   */
  readonly holdArtifacts: boolean;
  /**
   * The week's record when this run took the lock (none for a week never run). `deliver` compares
   * the store with it to see that another run delivered the week while this one worked.
   */
  readonly previousRecord?: RunRecord;
  /**
   * The latest record of an earlier week that reached a channel, read when the window is the
   * config's (no `RunOptions.sinceDays`). `collect` reaches back to its start, where that run
   * collected up to, so a late run misses nothing. None for an explicit window or a first run.
   */
  readonly lastDelivered?: RunRecord;
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
    ...(options.reuse && { reuse: options.reuse }),
    ...(options.variant && { variant: options.variant }),
    logger: deps.logger.child({ runId: weekId }),
    disabledGuards: plannedDisabledGuards(deps),
    holdArtifacts: false,
  };
}

/**
 * The context of a run that holds the lock: its signal also fires when the lock is lost, so every
 * stage, fetch and model call stops as it does for the caller's signal (`Run aborted ...`).
 */
export function holdingLock(ctx: RunContext, lockLost: AbortSignal): RunContext {
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, lockLost]) : lockLost;
  return { ...ctx, signal, lockLost };
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
