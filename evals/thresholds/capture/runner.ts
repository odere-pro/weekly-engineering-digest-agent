// How a capture walks its subjects: one call at a time, a failed call kept as its message,
// progress every few subjects, wall-clock time per phase.
import type { Clock } from '../../../src/shared/clock';
import { errorMessage } from '../../../src/shared/errors';
import type { Failed } from './schemas';

/** One line per milestone or failed call, so a long run can be followed. */
export type Progress = (line: string) => void;

const PROGRESS_EVERY = 10;

/** A failed call becomes a record of its message, so one bad item does not lose a long run. */
export async function attempt<T>(
  progress: Progress,
  what: string,
  call: () => Promise<T>,
): Promise<T | Failed> {
  try {
    return await call();
  } catch (error) {
    const message = errorMessage(error) || 'unknown error';
    progress(`${what} failed: ${message}`);
    return { error: message };
  }
}

/** Runs `call` on each value in turn (one model call at a time), logging every 10. */
export async function inTurn<T, R>(
  progress: Progress,
  label: string,
  values: readonly T[],
  call: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const [index, value] of values.entries()) {
    results.push(await call(value));
    const done = index + 1;
    if (done % PROGRESS_EVERY === 0 || done === values.length)
      progress(`${label}: ${done}/${values.length}`);
  }
  return results;
}

export async function timed<T>(
  clock: Clock,
  run: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = clock.now().getTime();
  const value = await run();
  // Wall-clock time: a clock step during a long run must not give a negative duration.
  return { value, ms: Math.max(0, clock.now().getTime() - start) };
}
