import type { RunResult } from '../../digest/types';
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

/**
 * Sends a failure note the scheduler composed itself, for a week that ended with no run record to
 * report: its run threw, or another run held the lock for the whole budget. `message` names the
 * week and a code or class name, never the text of an error.
 */
export type SendNote = (weekId: string, message: string) => Promise<void>;

/** The budgets that pay for a retry: another process holds the lock, or the run did not finish. */
export type RetryKind = 'lock-held' | 'failed';

/**
 * How one attempt ended, with `owed` the failed result whose note the attempt held back:
 * `finished` needs nothing more; `timed-out` hit its time limit, which nobody retries, and owes
 * its note if it held it, or `note` when it threw after the limit fired; `noted` threw because it
 * could not save its record, and had already sent a note saying so; or a reason to try again:
 * `lock-held`, a `failed` run carrying what it owes, or a run that `threw`, with the `note` that
 * says so should no attempt be left (it spends the `failed` budget).
 */
export type Attempt =
  | { kind: 'finished' }
  | { kind: 'timed-out'; owed?: RunResult; note?: string }
  | { kind: 'noted' }
  | { kind: 'lock-held'; error: string }
  | { kind: 'failed'; error: string; owed?: RunResult }
  | { kind: 'threw'; error: string; note: string };

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
  onNoRecord?: SendNote;
}

/** What the retry loop reads: how an attempt runs, how long each reason may retry, the timer. */
export interface RetryContext {
  settings: AttemptSettings;
  budgets: Readonly<Record<RetryKind, Budget>>;
  timer: Waiter;
  isStopped: () => boolean;
}
