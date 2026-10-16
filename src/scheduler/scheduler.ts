import type { RunResult } from '../core/runDigest.js';
import type { Clock } from '../shared/clock.js';
import { NotImplementedError } from '../shared/errors.js';
import type { Logger } from '../shared/telemetry.js';

export interface SchedulerOptions {
  cron: string;
  timeZone: string;
  run: (weekId: string) => Promise<RunResult>;
  /** Used for missed-week catch-up on start. */
  hasSentDigest: (weekId: string) => Promise<boolean>;
  clock: Clock;
  logger: Logger;
}

export interface SchedulerHandle {
  /** Next scheduled run, if any. */
  nextRun(): Date | null;
  stop(): void;
}

/** In-process weekly scheduler with missed-week catch-up (W1-16). */
export function startScheduler(_options: SchedulerOptions): Promise<SchedulerHandle> {
  throw new NotImplementedError('W1-16');
}
