import type { Config } from '../config/schema.js';
import type { ModelProfile } from '../config/profiles.js';
import type { Delivery } from '../ports/Delivery.js';
import type { InputGuard, OutputGuard } from '../ports/Guard.js';
import type { ModelProvider } from '../ports/ModelProvider.js';
import type { RunStore } from '../ports/RunStore.js';
import type { SourceFetcher } from '../ports/SourceFetcher.js';
import type { Clock } from '../shared/clock.js';
import { NotImplementedError } from '../shared/errors.js';
import type { Logger, Tracer } from '../shared/telemetry.js';
import type { ExitCode, RunRecord, SourceKind } from './schemas.js';

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
}

export interface RunResult {
  record: RunRecord;
  exitCode: ExitCode;
  /** Markdown of the winning digest, when one was produced. */
  markdown?: string;
}

/** The whole chain: collect, guard-input, classify, process, write, guard-output, select, deliver (W2-01). */
export function runDigest(_deps: DigestDeps, _options: RunOptions = {}): Promise<RunResult> {
  throw new NotImplementedError('W2-01');
}
