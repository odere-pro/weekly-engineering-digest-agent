// `pnpm eval:record`: freezes the last 6 ISO weeks of live feed output into evals/weeks/<week>/items.json (W2-03).
// The parts (bucketing, the week files, the report, the fetchers) are in evals/record/.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LoadOptions } from '../src/config/load';
import type { Item, Source, SourceKind } from '../src/domain/schemas';
import { collectStep } from '../src/sources/collect';
import type { SourceFetcher } from '../src/sources/SourceFetcher';
import { systemClock, type Clock } from '../src/shared/clock';
import { DigestError, errorMessage } from '../src/shared/errors';
import { isoWeekId, previousWeekIds } from '../src/shared/isoWeek';
import { noopLogger } from '../src/shared/telemetry';
import { createDefaultFetchers } from './record/fetchers/createDefaultFetchers';
import { resolveSources } from './record/fetchers/resolveSources';
import { reportLines } from './record/report/reportLines';
import { reportLogger } from './record/report/reportLogger';
import type { ResolvedSources, WeekRecord } from './record/types';
import { bucketByWeek } from './record/weeks/bucketByWeek';
import { recordWeek } from './record/weeks/recordWeek';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const RECORDED_WEEKS = 6;
/**
 * Feeds are asked for this many items per source, so no week is cut short by the usual cap. The
 * replay does not serve that many: it caps each source as production does (see runEval.ts).
 */
export const RECORDED_ITEMS_PER_SOURCE = 100;
const DEFAULT_OUT_DIR = fileURLToPath(new URL('./weeks', import.meta.url));

export interface RecordWeeksOptions {
  /** Complete ISO weeks before the current one to record. */
  weeks: number;
  /** Folder that gets one `<week>/` folder per recorded week. */
  outDir: string;
}

/** Everything the recorder reaches outside itself with; tests replace all of it. */
export interface RecordWeeksDeps {
  /** Default: digest.config.json, else the default allowlist. */
  sources?: readonly Source[];
  /** Where to look for the config when `sources` is not given. */
  config?: LoadOptions;
  /** Default: the real RSS and GitHub fetchers. */
  fetchers?: Readonly<Partial<Record<SourceKind, SourceFetcher>>>;
  clock?: Clock;
  /** One report line per call. Default: console.log. */
  log?: (line: string) => void;
  /** Retries per source. Default: the collect step's own. */
  retries?: number;
}

/**
 * Records the last `weeks` complete ISO weeks of feed output under `outDir`, prints counts, and
 * returns the recorded week ids, oldest first. A re-run only adds: items already in items.json are
 * kept, because feeds drop old entries and replacing the file would shrink a labeled week, while
 * items missed by a failed source on an earlier run are filled in.
 */
export async function recordWeeks(
  options: RecordWeeksOptions,
  deps: RecordWeeksDeps = {},
): Promise<string[]> {
  const { weeks, outDir } = options;
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new DigestError(`Cannot record ${weeks} weeks: use a whole number of 1 or more.`);
  }
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const weekIds = previousWeekIds(isoWeekId(now), weeks).toReversed();

  const resolved: ResolvedSources = deps.sources
    ? { sources: deps.sources, origin: 'config' }
    : await resolveSources(deps.config);
  const fetchers =
    deps.fetchers ?? createDefaultFetchers(resolved.githubToken, reportLogger(log, resolved));
  const collected = await collectStep(
    {
      sources: resolved.sources.map((source) => ({
        ...source,
        maxItems: RECORDED_ITEMS_PER_SOURCE,
      })),
      since: new Date(now.getTime() - (weeks + 1) * WEEK_MS),
      until: now,
      maxItemsPerSource: RECORDED_ITEMS_PER_SOURCE,
    },
    { fetchers, logger: noopLogger, clock, retries: deps.retries },
  );

  const records = await recordAllWeeks(bucketByWeek(collected.items, weekIds), outDir);
  for (const line of reportLines(outDir, records, resolved, collected.failedSources)) log(line);
  return weekIds;
}

async function recordAllWeeks(
  buckets: ReadonlyMap<string, readonly Item[]>,
  outDir: string,
): Promise<WeekRecord[]> {
  // allSettled: when one week fails, the others still finish writing before this rejects, so no
  // write outlives the call (a caller cleaning up the folder would otherwise race them).
  const settled = await Promise.allSettled(
    [...buckets].map(([weekId, items]) => recordWeek(join(outDir, weekId), weekId, items)),
  );
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  recordWeeks({ weeks: RECORDED_WEEKS, outDir: DEFAULT_OUT_DIR }).catch((error: unknown) => {
    console.error(`eval:record failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
