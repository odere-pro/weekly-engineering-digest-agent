import type { Config } from '../config/schema';
import type { ModelProfile } from '../config/profiles';
import type { Delivery, DigestMessage } from '../delivery/Delivery';
import type { InputGuard, OutputGuard } from '../guards/Guard';
import type { ModelProvider } from '../models/ModelProvider';
import type { RunStore } from '../store/RunStore';
import type { SourceFetcher } from '../sources/SourceFetcher';
import type { Clock } from '../shared/clock';
import type { Logger, Tracer } from '../shared/telemetry';
import type { ExitCode, Item, SourceKind } from '../domain/schemas';
import type { RunRecord } from '../store/runRecord';
import type { RunVariant } from './variant';

/** Everything the core needs; every entry point wires real or fake implementations. */
export interface DigestDeps {
  config: Config;
  profile: ModelProfile;
  model: ModelProvider;
  fetchers: Readonly<Partial<Record<SourceKind, SourceFetcher>>>;
  inputGuards: readonly InputGuard[];
  outputGuards: readonly OutputGuard[];
  deliveries: readonly Delivery[];
  store: RunStore;
  logger: Logger;
  tracer: Tracer;
  clock: Clock;
  /** Sampling the model calls use, copied into the run record. The container fills it. */
  sampling?: { seed: number; temperatureByRole: Record<string, number> };
}

export interface RunOptions {
  /** Window in days; defaults to config.windowDays. */
  sinceDays?: number;
  /** Write the digest to disk and send nothing. */
  dryRun?: boolean;
  /** Run even if the week already has a sent digest. */
  force?: boolean;
  /** Override the ISO week (evals, catch-up). */
  weekId?: string;
  /**
   * Ends the run `failed`, releasing the lock, once it has fired. Checked before each step and
   * before a resume's delivery; the collect step, the guards and the classify, write and select
   * model calls also stop within one call (they get it), while a delivery that has started
   * finishes first. The reason goes into run.json and the failure note as given, so the caller must compose it
   * (a timeout message), never copy model or feed text into it.
   */
  signal?: AbortSignal;
  /**
   * Default true. False holds back the failure note of a run that fails, for a caller that will
   * run the week again (the scheduler, on every attempt but the last). The record and error.json
   * are written either way. The note is sent anyway when no retry can follow: the run's failure
   * says it was told to stop (`signal`), or that only `digest run --force` can clear it
   * (`isUnretriable`). A note that stays held is the caller's to send, with `sendHeldNote`, if
   * the retry it waited for does not happen.
   */
  notifyFailure?: boolean;
  /**
   * Default false. True turns the template-only fallback off (W11-02), so a week whose drafts
   * all fail ends `blocked` as before. The eval replay (set it there) and tests use it to measure the writer on
   * its own. A real run always has the fallback: the config schema has no switch for it.
   */
  noFallback?: boolean;
  /**
   * Items from an earlier run of the week to start from instead of fetching everything.
   * `fetchSourceIds` undefined: fetch every source; `[]`: none; ids: only those. Fetched items
   * are merged with `items` (`mergeByUrl`, the saved ones win).
   */
  reuse?: { items: readonly Item[]; fetchSourceIds?: readonly string[] };
  /** A second run of a week that already has a digest: what it is for; see `variant.ts`. */
  variant?: RunVariant;
}

export interface RunResult {
  record: RunRecord;
  exitCode: ExitCode;
  /** The digest.md this run wrote or, on a resume, sent. None when no digest was made, or when
   * the week's earlier files stayed (`RunContext.holdArtifacts`). */
  markdown?: string;
  /**
   * What `deliver` sends for the winning draft, with its view, for every run that chose one: a
   * dry run too, though it sends nothing (W8-05 writes its local files from this). None when no
   * draft won. Unlike `markdown`, it does not depend on the week's earlier files staying.
   */
  message?: DigestMessage;
  /** Why the week's earlier record and files stayed instead of this run's; none when this run's
   * record was saved. `digest run` prints it, as there is no digest path to show then. */
  kept?: string;
}
