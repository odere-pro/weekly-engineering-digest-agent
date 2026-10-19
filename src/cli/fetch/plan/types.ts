import type { Source } from '../../../domain/schemas';
import type { Clock } from '../../../shared/clock';
import type { FetchRun } from '../sourceRun/types';

/** The options of `digest fetch` that choose what to fetch and where to write. */
export interface PlanOptions {
  /** Only these source ids; all sources in the config when absent. */
  source?: string[];
  /** Data folder to write into; the config's `dataDir` when absent or blank. */
  out?: string;
}

/** What planning takes from the command's deps. */
export interface PlanEnv {
  clock: Clock;
  /** A relative `--out` and the data folder are resolved against this. */
  cwd: string;
  fetch: typeof fetch;
  /** Per source, the feed and any article pages together. */
  sourceTimeoutMs: number;
}

/** Everything decided before the first request, so a bad option fails before any network use. */
export interface Plan {
  sources: Source[];
  /** The data folder written into. */
  root: string;
  /** The day folder below it (YYYY-MM-DD in the schedule's time zone). */
  day: string;
  startedAt: Date;
  windowDays: number;
  run: FetchRun;
}
