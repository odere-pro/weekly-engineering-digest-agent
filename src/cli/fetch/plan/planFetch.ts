import { resolve } from 'node:path';
import type { LoadedConfig } from '../../../config/load';
import { dayOf } from '../../../store/layout';
import { buildFetchers } from '../sourceRun/buildFetchers';
import { createRecorder } from '../sourceRun/recorder';
import type { FetchRun } from '../sourceRun/types';
import { selectSources } from './selectSources';
import type { Plan, PlanEnv, PlanOptions } from './types';

const DAY_MS = 86_400_000;

/**
 * Decides everything before the first request: which sources, where to write, which day, which
 * window, and the fetchers with a recorder. `days` is a parsed `--since`; undefined means the
 * configured window. Throws on an unknown source id.
 */
export function planFetch(
  options: PlanOptions,
  days: number | undefined,
  { config, secrets }: Pick<LoadedConfig, 'config' | 'secrets'>,
  env: PlanEnv,
  redact: (text: string) => string,
): Plan {
  const sources = selectSources(config.sources, options.source);
  const startedAt = env.clock.now();
  const root = resolve(env.cwd, options.out?.trim() || config.dataDir);
  const day = dayOf(startedAt, config.schedule.timeZone);
  const windowDays = days ?? config.windowDays;
  const recorder = createRecorder();
  const run: FetchRun = {
    fetchers: buildFetchers(secrets, env.fetch, recorder),
    recorder,
    window: { since: new Date(startedAt.getTime() - windowDays * DAY_MS), until: startedAt },
    maxItemsPerSource: config.maxItemsPerSource,
    clock: env.clock,
    timeoutMs: env.sourceTimeoutMs,
    redact,
  };
  return { sources, root, day, startedAt, windowDays, run };
}
