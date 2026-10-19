export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** The longest delay setTimeout holds; a larger one fires at once, so such a wait means none. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** True for a wait a timer can hold: above zero and at most `MAX_TIMER_MS`. NaN is not one. */
export function isTimerDelay(ms: number): boolean {
  return ms > 0 && ms <= MAX_TIMER_MS;
}
