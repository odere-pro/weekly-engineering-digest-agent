// Measures whether rescoring the filtered items with the writer model helps (W6-08):
//   tsx evals/rescoreReplay.ts --profile light --flag on|off [--config <digest.config.json>]
// Replays classify and select over the recorded weeks (no write, no guards, the same per-source
// cap `runEval` serves) and the classifier cases; prints must-include recall, must-exclude
// leaks and classifier accuracy.
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app/container.js';
import { loadConfig, platformOf } from '../src/config/load.js';
import { resolveProfile } from '../src/config/profiles.js';
import { ProfileNameSchema, type Config, type ProfileName } from '../src/config/schema.js';
import type { Item } from '../src/core/schemas.js';
import { areaHintsOf, classifyStep, type ClassifyDeps } from '../src/core/steps/classify.js';
import { processStep } from '../src/core/steps/process.js';
import { systemClock, type Clock } from '../src/shared/clock.js';
import { errorMessage } from '../src/shared/errors.js';
import type { ModelProvider } from '../src/ports/ModelProvider.js';
import type { Logger } from '../src/shared/telemetry.js';
import {
  classifierAccuracy,
  mustExcludeLeaks,
  mustIncludeRecall,
  type WeekHits,
} from './metrics.js';
import { loadEvalCases, type EvalCases } from './runEval.js';

/** Spec: must-include recall is counted in the top 5, whatever topN the local config says. */
const REPLAY_TOP_N = 5;
const MS_PER_SECOND = 1000;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export interface RescoreReplayDeps {
  model: ModelProvider;
  config: Config;
  logger: Logger;
  clock: Clock;
}

export interface RescoreResult {
  rescoreWithWriter: boolean;
  weeks: number;
  /** Mean must-include items found in the top 5 per week (gate: at least 3). */
  mustIncludeRecall: number | null;
  mustExcludeLeaks: number | null;
  /** Share of classifier cases with the right area and relevance. */
  classifierAccuracy: number | null;
  /** Mean wall-clock seconds to classify and select one week. */
  secondsPerWeek: number | null;
}

/** Like the real fetchers: a source's newest items first, at most its cap. */
function servedItems(items: readonly Item[], config: Config): Item[] {
  return [...new Set(items.map((item) => item.sourceId))].flatMap((sourceId) => {
    const cap =
      config.sources.find((source) => source.id === sourceId)?.maxItems ?? config.maxItemsPerSource;
    return items
      .filter((item) => item.sourceId === sourceId)
      .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, cap);
  });
}

function classifyDeps(deps: RescoreReplayDeps, rescore: boolean): ClassifyDeps {
  const { config } = deps;
  return {
    model: deps.model,
    focusAreas: config.focusAreas,
    logger: deps.logger,
    areaHints: areaHintsOf(config.sources),
    rescoreWithWriter: rescore,
    minRelevance: config.thresholds.minRelevance,
  };
}

async function replayWeek(
  week: EvalCases['weeks'][number],
  deps: RescoreReplayDeps,
  rescore: boolean,
): Promise<{ hits: WeekHits; seconds: number }> {
  const served = servedItems(week.items, deps.config);
  const startMs = deps.clock.now().getTime();
  const scored = await classifyStep(served, classifyDeps(deps, rescore));
  const { selected } = processStep({
    items: scored,
    sentUrls: new Set<string>(),
    thresholds: deps.config.thresholds,
    topN: REPLAY_TOP_N,
  });
  const seconds = Math.max(0, deps.clock.now().getTime() - startMs) / MS_PER_SECOND;
  const hits: WeekHits = {
    mustInclude: week.labels.mustInclude,
    mustExclude: week.labels.mustExclude,
    digestItemIds: selected.map((item) => item.id),
    visibleIds: new Set(served.map((item) => item.id)),
  };
  return { hits, seconds };
}

async function replayClassifierCases(
  cases: EvalCases['classifier']['cases'],
  deps: RescoreReplayDeps,
  rescore: boolean,
): Promise<number | null> {
  if (cases.length === 0) return null;
  const scored = await classifyStep(
    cases.map((c) => c.item),
    classifyDeps(deps, rescore),
  );
  const results = cases.flatMap((c, i) => {
    const classification = scored[i]?.classification;
    return classification
      ? [
          {
            expected: c.expected,
            actual: { area: classification.area, relevance: classification.relevance },
          },
        ]
      : [];
  });
  return classifierAccuracy(results).value;
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;

/** One pass over the recorded weeks and the classifier cases with the flag at `rescore`. */
export async function replayRescore(
  cases: EvalCases,
  deps: RescoreReplayDeps,
  rescore: boolean,
): Promise<RescoreResult> {
  const runs: { hits: WeekHits; seconds: number }[] = [];
  for (const week of cases.weeks) runs.push(await replayWeek(week, deps, rescore));
  const hits = runs.map((run) => run.hits);
  return {
    rescoreWithWriter: rescore,
    weeks: cases.weeks.length,
    mustIncludeRecall: mustIncludeRecall(hits).value,
    mustExcludeLeaks: mustExcludeLeaks(hits).value,
    classifierAccuracy: await replayClassifierCases(cases.classifier.cases, deps, rescore),
    secondsPerWeek: mean(runs.map((run) => run.seconds)),
  };
}

export function formatResult(profile: string, result: RescoreResult): string {
  const num = (value: number | null, digits: number): string =>
    value === null ? 'n/a' : value.toFixed(digits);
  const accuracy =
    result.classifierAccuracy === null ? 'n/a' : `${(result.classifierAccuracy * 100).toFixed(1)}%`;
  return [
    `profile: ${profile}  rescoreWithWriter: ${result.rescoreWithWriter ? 'on' : 'off'}  weeks: ${result.weeks}`,
    `must-include recall: ${num(result.mustIncludeRecall, 2)} of ${REPLAY_TOP_N}`,
    `must-exclude leaks: ${num(result.mustExcludeLeaks, 2)}`,
    `classifier accuracy: ${accuracy}`,
    `seconds per week: ${num(result.secondsPerWeek, 1)}`,
    '',
  ].join('\n');
}

// --- CLI ------------------------------------------------------------------------------------

const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));
const USAGE =
  'Usage: tsx evals/rescoreReplay.ts --profile light|fast|... --flag on|off [--config <digest.config.json>]\n';

export interface RescoreCliIo {
  casesDir: string;
  run: (
    options: { profile: ProfileName; config: string | undefined },
    cases: EvalCases,
    rescore: boolean,
  ) => Promise<RescoreResult>;
  loadCases: (dir: string) => Promise<EvalCases>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

async function runWithApp(
  options: { profile: ProfileName; config: string | undefined },
  cases: EvalCases,
  rescore: boolean,
): Promise<RescoreResult> {
  const loaded = await loadConfig({ configPath: options.config });
  const switched = {
    ...loaded,
    config: { ...loaded.config, profile: options.profile },
    profile: resolveProfile(options.profile, platformOf(loaded), loaded.config.models.writers),
  };
  const app = await buildApp(switched);
  try {
    return await replayRescore(
      cases,
      {
        model: app.deps.model,
        config: switched.config,
        logger: app.deps.logger,
        clock: systemClock,
      },
      rescore,
    );
  } finally {
    await app.close();
  }
}

const defaultIo: RescoreCliIo = {
  casesDir: EVALS_DIR,
  run: runWithApp,
  loadCases: loadEvalCases,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

type Parsed =
  | { ok: true; profile: ProfileName; flag: boolean; config: string | undefined }
  | { ok: false; reason: string };

function parseCli(args: readonly string[]): Parsed {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        profile: { type: 'string' },
        flag: { type: 'string' },
        config: { type: 'string' },
      },
    });
    const profile = ProfileNameSchema.safeParse(values.profile);
    if (!profile.success) return { ok: false, reason: 'unknown or missing --profile' };
    if (values.flag !== 'on' && values.flag !== 'off')
      return { ok: false, reason: '--flag must be on or off' };
    return { ok: true, profile: profile.data, flag: values.flag === 'on', config: values.config };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Returns the exit code: 0 done, 1 failed, 2 usage. */
export async function runCli(
  args: readonly string[],
  overrides: Partial<RescoreCliIo> = {},
): Promise<number> {
  const io: RescoreCliIo = { ...defaultIo, ...overrides };
  const parsed = parseCli(args);
  if (!parsed.ok) {
    io.stderr(`${parsed.reason}\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const cases = await io.loadCases(io.casesDir);
    const result = await io.run(
      { profile: parsed.profile, config: parsed.config },
      cases,
      parsed.flag,
    );
    io.stdout(formatResult(parsed.profile, result));
    return EXIT_OK;
  } catch (error) {
    io.stderr(`rescoreReplay failed: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
