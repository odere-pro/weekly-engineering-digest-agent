import { GuardsConfigSchema } from '../../src/config/schema';
import type { DigestDeps, RunOptions, RunResult } from '../../src/digest/types';
import type { Item } from '../../src/domain/schemas';
import { fixedClock, type Clock } from '../../src/shared/clock';
import type { RunRecord } from '../../src/store/runRecord';
import { createEvalStore } from './evalStore';
import {
  recordInputGuards,
  recordOutputGuards,
  type InputVerdict,
  type OutputVerdict,
} from './guardVerdicts';
import { endOfWeek, recordedFetchers, servedIds, sourcesOf, WEEK_DAYS } from './recordedItems';

/** Spec: must-include recall is counted in the top 5, whatever topN the local config says. */
const REPLAY_TOP_N = 5;

/** What a replay needs from the harness: the digest runner and a wall clock for timings. */
export interface ReplayDeps {
  runDigest: (deps: DigestDeps, options: RunOptions) => Promise<RunResult>;
  /** Wall clock for dates and timings. Replays use their own fixed clock. */
  clock: Clock;
}

export interface Replay {
  weekId: string;
  /** Everything the fetchers served, attack items included: the items the pipeline could see. */
  items: readonly Item[];
  markdown: string | undefined;
  record: RunRecord;
  durationMs: number;
  inputVerdicts: InputVerdict[];
  /** What the output guards said about each draft, reasons included. */
  outputVerdicts: OutputVerdict[];
  /** Ids of the items the replay served. */
  served: ReadonlySet<string>;
}

/** A dry run of runDigest on recorded items: no network, no deliveries, every guard on. */
export async function replay(
  app: DigestDeps,
  deps: ReplayDeps,
  weekId: string,
  items: readonly Item[],
): Promise<Replay> {
  const inputVerdicts: InputVerdict[] = [];
  const outputVerdicts: OutputVerdict[] = [];
  const sources = sourcesOf(items, app.config.sources);
  const served = servedIds(items, sources, app.config.maxItemsPerSource);
  const replayDeps: DigestDeps = {
    ...app,
    config: {
      ...app.config,
      sources,
      topN: REPLAY_TOP_N,
      guards: GuardsConfigSchema.parse({}),
    },
    fetchers: recordedFetchers(items),
    inputGuards: recordInputGuards(app.inputGuards, inputVerdicts),
    outputGuards: recordOutputGuards(app.outputGuards, outputVerdicts),
    deliveries: [],
    store: createEvalStore(),
    clock: fixedClock(endOfWeek(weekId)),
  };
  app.logger.info('Eval replays a week', { weekId, items: items.length });
  const startMs = deps.clock.now().getTime();
  const result = await deps.runDigest(replayDeps, {
    dryRun: true,
    weekId,
    sinceDays: WEEK_DAYS,
    // The eval measures the writers on their own: no digest floor.
    noFallback: true,
  });
  const durationMs = Math.max(0, deps.clock.now().getTime() - startMs);
  return {
    weekId,
    items: items.filter((item) => served.has(item.id)),
    served,
    markdown: result.markdown,
    record: result.record,
    durationMs,
    inputVerdicts,
    outputVerdicts,
  };
}
