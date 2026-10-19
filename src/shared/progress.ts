import { systemClock, type Clock } from './clock';
import type { Logger } from './telemetry';

/** One line after this many items, or after `PROGRESS_EVERY_MS`, whichever comes first. */
export const PROGRESS_EVERY_ITEMS = 25;
export const PROGRESS_EVERY_MS = 60_000;

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;

export interface ProgressOptions {
  /** What is being worked through: a guard id or a step name. Never item text. */
  label: string;
  total: number;
  logger: Logger;
  clock?: Clock;
  everyItems?: number;
  everyMs?: number;
}

export interface Progress {
  /** Call once per finished item; logs when a line is due. Calls past `total` are ignored. */
  tick(): void;
}

/**
 * Tracks a long loop over `total` items and logs one `Progress` line now and then: done, total,
 * the time so far and an estimate of the time left. The estimate is the median time between two
 * finished items times the items left; the median, because the first item of a step often
 * includes loading the model. It measures the time between ticks, so it is right however many
 * items run at once. Fields are counts, times and `label` only.
 */
export function startProgress(options: ProgressOptions): Progress {
  const { label, total, logger } = options;
  const clock = options.clock ?? systemClock;
  const everyItems = options.everyItems ?? PROGRESS_EVERY_ITEMS;
  const everyMs = options.everyMs ?? PROGRESS_EVERY_MS;
  const startedAt = clock.now().getTime();
  const intervals: number[] = [];
  let lastTickAt = startedAt;
  let lastLoggedAt = startedAt;
  let done = 0;

  return {
    tick: () => {
      if (done >= total) return;
      const now = clock.now().getTime();
      done += 1;
      intervals.push(now - lastTickAt);
      lastTickAt = now;
      const due = done === total || done % everyItems === 0 || now - lastLoggedAt >= everyMs;
      if (!due) return;
      lastLoggedAt = now;
      const medianMs = median(intervals);
      const etaMs = (total - done) * medianMs;
      logger.info('Progress', {
        label,
        done,
        total,
        elapsedMs: now - startedAt,
        medianMs,
        etaMs,
        eta: formatDuration(etaMs),
      });
    },
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** "45 s", "2 min 30 s", "1 h 5 min": whole seconds, and no seconds once it is an hour or more. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / MS_PER_SECOND);
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
  return `${seconds} s`;
}
