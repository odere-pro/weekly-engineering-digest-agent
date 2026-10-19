// Measures whether rescoring the filtered items with the writer model helps (W6-08):
//   tsx evals/rescoreReplay.ts --profile light --flag on|off [--config <digest.config.json>]
//     [--calibration <file>] [--holdout 2026-W40,2026-W41]
// Replays classify and select over the recorded weeks (no write, no guards, the same per-source
// cap `runEval` serves) and the classifier cases; prints must-include recall, must-exclude
// leaks and classifier accuracy.
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app/container';
import { loadConfig, platformOf } from '../src/config/load';
import { resolveProfile } from '../src/config/profiles';
import { ProfileNameSchema, type Config, type ProfileName } from '../src/config/schema';
import type { Item, ScoredItem } from '../src/domain/schemas';
import { areaHintsOf, classifyStep, type ClassifyDeps } from '../src/classify/classify';
import {
  CalibrationSchema,
  calibrateClassification,
  type Calibration,
} from '../src/process/calibration';
import { PAIRWISE_TOP, pairwiseRank } from '../src/classify/pairwise';
import { processStep, type ProcessInput } from '../src/process/process';
import { systemClock, type Clock } from '../src/shared/clock';
import { errorMessage } from '../src/shared/errors';
import type { ModelProvider } from '../src/models/ModelProvider';
import type { Logger } from '../src/shared/telemetry';
import { classifierAccuracy, mustExcludeLeaks, mustIncludeRecall, type WeekHits } from './metrics';
import { loadEvalCases, type EvalCases } from './runEval';
import { CASE_STRIDE, parseHoldoutWeeks } from './thresholds/split';

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
  /** Applied by the process step and to the classifier cases (W11-06). Absent: as before. */
  calibration?: Calibration | undefined;
  /** Re-rank the best candidates with a pairwise tournament before the final pick (W11-07). */
  pairwise?: boolean | undefined;
}

export interface RescoreResult {
  rescoreWithWriter: boolean;
  pairwise?: boolean;
  calibrated?: boolean;
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

/** The process step, with the optional pairwise re-rank of the best `PAIRWISE_TOP` survivors. */
async function selectTop(scored: ScoredItem[], deps: RescoreReplayDeps) {
  const base: ProcessInput = {
    items: scored,
    sentUrls: new Set<string>(),
    thresholds: deps.config.thresholds,
    topN: REPLAY_TOP_N,
    calibration: deps.calibration,
  };
  if (!deps.pairwise) return processStep(base);
  const { selected: candidates } = processStep({ ...base, topN: PAIRWISE_TOP });
  const pairwiseOrder = await pairwiseRank(candidates, {
    model: deps.model,
    focusAreas: deps.config.focusAreas,
    logger: deps.logger,
  });
  return processStep({ ...base, pairwiseOrder });
}

async function replayWeek(
  week: EvalCases['weeks'][number],
  deps: RescoreReplayDeps,
  rescore: boolean,
): Promise<{ hits: WeekHits; seconds: number }> {
  const served = servedItems(week.items, deps.config);
  const startMs = deps.clock.now().getTime();
  const scored = await classifyStep(served, classifyDeps(deps, rescore));
  const { selected } = await selectTop(scored, deps);
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
    if (!classification) return [];
    const { area, relevance } = deps.calibration
      ? calibrateClassification(deps.calibration, classification)
      : classification;
    return [{ expected: c.expected, actual: { area, relevance } }];
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
    ...(deps.pairwise ? { pairwise: true } : {}),
    ...(deps.calibration ? { calibrated: true } : {}),
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
    `profile: ${profile}  rescoreWithWriter: ${result.rescoreWithWriter ? 'on' : 'off'}  calibration: ${result.calibrated ? 'on' : 'off'}  pairwise: ${result.pairwise ? 'on' : 'off'}  weeks: ${result.weeks}`,
    `must-include recall: ${num(result.mustIncludeRecall, 2)} of ${REPLAY_TOP_N}`,
    `must-exclude leaks: ${num(result.mustExcludeLeaks, 2)}`,
    `classifier accuracy: ${accuracy}`,
    `seconds per week: ${num(result.secondsPerWeek, 1)}`,
    '',
  ].join('\n');
}

/** The holdout split of W6-04: the named weeks and every third classifier case (the 3rd, 6th, ...). */
export function holdoutOf(cases: EvalCases, weeks: readonly string[]): EvalCases {
  return {
    ...cases,
    weeks: cases.weeks.filter((week) => weeks.includes(week.weekId)),
    classifier: {
      ...cases.classifier,
      cases: cases.classifier.cases.filter((_, i) => i % CASE_STRIDE === CASE_STRIDE - 1),
    },
  };
}

// --- CLI ------------------------------------------------------------------------------------

const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));
const USAGE =
  'Usage: tsx evals/rescoreReplay.ts --profile light|fast|... --flag on|off [--config <digest.config.json>] [--calibration <file>] [--holdout <weeks>] [--pairwise on|off]\n';

interface RunOptions {
  profile: ProfileName;
  config: string | undefined;
  calibration?: Calibration | undefined;
  pairwise?: boolean;
}

export interface RescoreCliIo {
  casesDir: string;
  run: (options: RunOptions, cases: EvalCases, rescore: boolean) => Promise<RescoreResult>;
  loadCases: (dir: string) => Promise<EvalCases>;
  loadCalibration: (path: string) => Promise<Calibration>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

async function runWithApp(
  options: RunOptions,
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
        calibration: options.calibration,
        pairwise: options.pairwise,
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
  loadCalibration: async (path) =>
    CalibrationSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

type Parsed =
  | {
      ok: true;
      profile: ProfileName;
      flag: boolean;
      config: string | undefined;
      calibration: string | undefined;
      holdout: string[] | undefined;
      pairwise: boolean;
    }
  | { ok: false; reason: string };

function parseCli(args: readonly string[]): Parsed {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        profile: { type: 'string' },
        flag: { type: 'string' },
        config: { type: 'string' },
        calibration: { type: 'string' },
        holdout: { type: 'string' },
        pairwise: { type: 'string' },
      },
    });
    const profile = ProfileNameSchema.safeParse(values.profile);
    if (!profile.success) return { ok: false, reason: 'unknown or missing --profile' };
    if (values.flag !== 'on' && values.flag !== 'off')
      return { ok: false, reason: '--flag must be on or off' };
    if (values.pairwise !== undefined && values.pairwise !== 'on' && values.pairwise !== 'off')
      return { ok: false, reason: '--pairwise must be on or off' };
    return {
      ok: true,
      profile: profile.data,
      flag: values.flag === 'on',
      config: values.config,
      calibration: values.calibration,
      holdout: values.holdout === undefined ? undefined : parseHoldoutWeeks(values.holdout),
      pairwise: values.pairwise === 'on',
    };
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
    const all = await io.loadCases(io.casesDir);
    const cases = parsed.holdout ? holdoutOf(all, parsed.holdout) : all;
    const calibration =
      parsed.calibration === undefined ? undefined : await io.loadCalibration(parsed.calibration);
    const result = await io.run(
      { profile: parsed.profile, config: parsed.config, calibration, pairwise: parsed.pairwise },
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
