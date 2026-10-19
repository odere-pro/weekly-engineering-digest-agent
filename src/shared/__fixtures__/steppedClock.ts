// A clock a test moves by hand: `fixedClock` that `advance` re-points. For code that measures the
// time between two events (progress, ETA) without a real wait.
import { fixedClock, type Clock } from '../clock';

export interface SteppedClock {
  readonly clock: Clock;
  readonly advance: (ms: number) => void;
}

export function steppedClock(start: Date | string = '2026-10-19T21:00:00Z'): SteppedClock {
  let current = fixedClock(start);
  return {
    clock: { now: () => current.now() },
    advance: (ms) => {
      current = fixedClock(new Date(current.now().getTime() + ms));
    },
  };
}
