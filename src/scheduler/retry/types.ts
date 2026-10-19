import type { RunResult } from '../../digest/runDigest';
import type { Logger } from '../../shared/telemetry';
import type { Budget, Waiter } from './wait';

/** What started a run: the cron, or the catch-up of a week missed while the service was down. */
export type Trigger = 'schedule' | 'catch-up';

/** What the scheduler tells a run about the attempt it is making. */
export interface RunAttempt {
  /**
   * Pass it on as `RunOptions.notifyFailure`. False while this attempt will be tried again if it
   * fails, so a root cause that survives every attempt sends one failure note, from the last.
   * A run that nobody can retry (a timeout, a resume that needs `--force`) sends its note at once
   * whatever this says. Always true when the scheduler has no `onGiveUp`: nobody could send a
   * note it held back.
   */
  readonly notifyFailure: boolean;
}

/** Runs one week; see `SchedulerOptions.run`. */
export type RunWeek = (
  weekId: string,
  signal: AbortSignal,
  attempt?: RunAttempt,
) => Promise<RunResult>;

/** Sends the failure note of a week that failed and will not be tried again. */
export type GiveUp = (weekId: string, lastResult: RunResult) => Promise<void>;

/** Why another attempt may help: another process holds the lock, or the run ended `failed`. */
export type RetryKind = 'lock-held' | 'failed';

/**
 * How one attempt ended, with `owed` the failed result whose note the attempt held back:
 * `finished` needs nothing more; `timed-out` hit its time limit, which nobody retries, and owes
 * its note if it held it; `threw` with an error that no retry fixes (`noted`: the run had already
 * sent a note saying why); or a reason to try again, a failed run carrying what it owes.
 */
export type Attempt =
  | { kind: 'finished' }
  | { kind: 'timed-out'; owed?: RunResult }
  | { kind: 'threw'; noted: boolean }
  | { kind: 'lock-held'; error: string }
  | { kind: 'failed'; error: string; owed?: RunResult };

/** The week and the trigger that every log line of a tick names. */
export interface RetryWhere {
  weekId: string;
  trigger: Trigger;
}

/** What one attempt needs from the scheduler's options. */
export interface AttemptSettings {
  run: RunWeek;
  logger: Logger;
  runTimeoutMs: number;
  onGiveUp?: GiveUp;
}

/** What the retry loop reads: how an attempt runs, how long each reason may retry, the timer. */
export interface RetryContext {
  settings: AttemptSettings;
  budgets: Readonly<Record<RetryKind, Budget>>;
  timer: Waiter;
  isStopped: () => boolean;
}
