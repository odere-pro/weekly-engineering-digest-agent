import { isTimerDelay } from '../timing';

/** The wait between attempts of one kind, and how many attempts it may add. */
export interface Budget {
  everyMs: number;
  max: number;
}

/**
 * Retrying needs a wait a timer can hold and a count above zero; zero, negative, NaN and a wait
 * beyond `MAX_TIMER_MS` (which would fire at once) turn it off.
 */
export function budgetOf(everyMs: number, count: number): Budget {
  const on = isTimerDelay(everyMs) && count > 0;
  return { everyMs, max: on ? Math.floor(count) : 0 };
}

/** One timer at a time, shared by every wait between attempts, that stop() can cut short. */
export interface Waiter {
  /** Resolves true when the time has passed, false when cancel() cut the wait short. */
  wait: (ms: number) => Promise<boolean>;
  cancel: () => void;
  isWaiting: () => boolean;
}

export function createWaiter(): Waiter {
  let cancelWait: (() => void) | undefined;
  return {
    wait: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          cancelWait = undefined;
          resolve(true);
        }, ms);
        cancelWait = () => {
          clearTimeout(timer);
          cancelWait = undefined;
          resolve(false);
        };
      }),
    cancel: () => {
      cancelWait?.();
    },
    isWaiting: () => cancelWait !== undefined,
  };
}
