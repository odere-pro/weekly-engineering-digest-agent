import { HOUR_MS, isTimerDelay, MINUTE_MS } from '../timing';

/** Longest a run may take before its signal fires, when the caller sets no limit. */
export const DEFAULT_RUN_TIMEOUT_MS = 3 * HOUR_MS;

export interface RunLimit {
  /** Fires, with a reason the scheduler wrote, when the limit passes. */
  signal: AbortSignal;
  timedOut: () => boolean;
  /** Stops the timer; call when the run is over. */
  clear: () => void;
}

/** A signal that fires after `ms`. A limit that is not a positive number a timer can hold is none. */
export function startRunLimit(ms: number, onTimeout: () => void): RunLimit {
  const controller = new AbortController();
  const timer = isTimerDelay(ms)
    ? setTimeout(() => {
        onTimeout();
        // The reason lands in run.json and the failure note: the limit, nothing from the run.
        controller.abort(new Error(`run timed out after ${describeDuration(ms)}`));
      }, ms)
    : undefined;
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/** The duration in the largest unit that holds it whole: `3 h`, `90 min`, `30 s`, `1500 ms`. */
export function describeDuration(ms: number): string {
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}
