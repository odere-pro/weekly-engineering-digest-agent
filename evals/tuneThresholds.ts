// Tunes minRelevance, maxHype, maxMinorRelease and guardFlag for one profile (W3-03).
// `capture` calls the models once and saves their raw outputs; `sweep` picks the thresholds from
// those outputs offline, with no model calls:
//   tsx evals/tuneThresholds.ts capture --config data/thresholds/light.json
//   tsx evals/tuneThresholds.ts sweep evals/thresholds/raw/<date>-light.json
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import { buildApp, type AppHandle } from '../src/app/container';
import { loadConfig } from '../src/config/load';
import {
  ProfileNameSchema,
  ThresholdsSchema,
  type ProfileName,
  type Thresholds,
} from '../src/config/schema';
import type { GuardCheckId } from '../src/domain/schemas';
import { systemClock, type Clock } from '../src/shared/clock';
import type { ModelProvider } from '../src/models/ModelProvider';
import { DigestError, errorMessage } from '../src/shared/errors';
import { loadEvalCases } from './runEval';
import {
  RawCaptureSchema,
  captureRaw,
  failedCalls,
  isFailed,
  type CaptureDeps,
  type EvalSet,
  type RawCapture,
  type WeekItemRecord,
} from './thresholds/capture';
import {
  compareSides,
  defaultSplit,
  parseHoldoutWeeks,
  scoreSide,
  scorecardAccuracy,
  sideSize,
  splitCapture,
  splitLines,
  worst,
  type Split,
} from './thresholds/split';
import {
  EPSILON,
  KEEP_MIN_LABEL,
  MARGIN_STEPS,
  MAX_FALSE_BLOCK_RATE,
  MIN_CLASSIFIER_ACCURACY,
  keepsItem,
  sweepFilter,
  sweepGuardFlag,
  type FilterThresholds,
} from './thresholds/sweep';

// --- Tuning result --------------------------------------------------------------------------

const Count = z.number().int().min(0);
const Ratio = z.number().min(0).max(1).nullable();
const FilterOutcomeSchema = z.object({
  accuracy: Ratio,
  kept: Count,
  dropped: Count,
  wronglyKept: Count,
  wronglyDropped: Count,
});
const CurveSchema = z.array(z.object({ value: z.number(), accuracy: Ratio }));
const WeekCheckSchema = z.object({
  items: Count,
  kept: Count,
  mustInclude: Count,
  mustIncludeKept: Count,
  mustExclude: Count,
  mustExcludeDropped: Count,
});
export type WeekCheck = z.infer<typeof WeekCheckSchema>;
const GuardFlagPointSchema = z.object({
  value: z.number(),
  policyFalseBlockRate: Ratio,
  attacksCaught: Count,
  rubricFalseBlockRate: Ratio,
  plantedFlagged: Count,
  anyFalseBlockRate: Ratio,
  anyAttacksCaught: Count,
});
const BlockedSchema = z.object({ itemId: z.string(), title: z.string(), from: z.string() });
const MinGateSchema = z.object({ value: Ratio, min: z.number(), pass: z.boolean() });
const MaxGateSchema = z.object({ value: Ratio, max: z.number(), pass: z.boolean() });

const SideSizeSchema = z.object({
  weeks: z.array(z.string()),
  classifierCases: Count,
  cleanItems: Count,
  attacks: Count,
  drafts: Count,
});
const SideScoreSchema = z.object({
  classifierAccuracy: Ratio,
  filterAccuracy: Ratio,
  falseBlocks: Ratio,
  attackRecall: Ratio,
});
const GapSchema = z.number().min(-1).max(1).nullable();

/** evals/thresholds/<date>-<profile>.json: what `sweep` makes of one raw capture. */
export const TuningResultSchema = z.object({
  profile: ProfileNameSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  ollamaVersion: z.string().nullable(),
  models: RawCaptureSchema.shape.models,
  method: z.record(z.string(), z.string()),
  baseline: ThresholdsSchema,
  proposed: ThresholdsSchema,
  classifier: z.object({
    cases: Count,
    failed: Count,
    /** The scorecard's classifier accuracy (area and relevance within 0.5); no threshold changes it. */
    scorecard: z.object({ value: Ratio, area: Ratio, relevance: Ratio }),
    filter: z.object({ baseline: FilterOutcomeSchema, proposed: FilterOutcomeSchema }),
    curves: z.object({
      minRelevance: CurveSchema,
      maxHype: CurveSchema,
      maxMinorRelease: CurveSchema,
    }),
  }),
  /** The filter on every recorded week item, against the maintainer's week labels. */
  weeks: z.object({ failed: Count, baseline: WeekCheckSchema, proposed: WeekCheckSchema }),
  guards: z.object({
    clean: Count,
    attacks: Count,
    controls: Count,
    planted: Count,
    failed: z.object({ clefPolicy: Count, graniteRisk: Count, clefRubric: Count }),
    baseline: GuardFlagPointSchema,
    proposed: GuardFlagPointSchema,
    clefPolicyFalseBlocks: z.array(BlockedSchema),
    graniteRisk: z.object({
      clean: Count,
      attacks: Count,
      falseBlockRate: Ratio,
      attacksCaught: Count,
      falseBlocks: z.array(BlockedSchema),
    }),
    curve: z.array(GuardFlagPointSchema),
  }),
  acceptance: z.object({
    /** The spec's classifier gate, on the scorecard's measure. */
    classifierAccuracy: MinGateSchema,
    /** Keep or drop as labelled, at the proposed thresholds. */
    filterAccuracy: MinGateSchema,
    /** The spec's per-guard gate: the worst input or output guard at the proposed guardFlag. */
    guardFalseBlocks: MaxGateSchema,
    /** Mode "any", the default: clean week items that either input guard flags. */
    inputFalseBlocksAnyMode: MaxGateSchema,
    /** Every model call answered; in a real run a failed call fails the run. */
    failedCalls: z.object({ count: Count, pass: z.boolean() }),
  }),
  timingsMs: z.record(z.string(), z.number().min(0)),
  /**
   * Thresholds are picked on `train` and scored on both sides. Every section above describes the
   * train side. Results from before W6-04 have neither field and picked on all the data.
   */
  split: z.object({ train: SideSizeSchema, holdout: SideSizeSchema, caseStride: Count }).optional(),
  scores: z
    .object({
      train: SideScoreSchema,
      holdout: SideScoreSchema,
      gap: z.object({
        classifierAccuracy: GapSchema,
        filterAccuracy: GapSchema,
        falseBlocks: GapSchema,
      }),
      warnings: z.array(z.string()),
    })
    .optional(),
});
export type TuningResult = z.infer<typeof TuningResultSchema>;

const METHOD = {
  keep: `an item belongs in the digest when its label is relevance ${KEEP_MIN_LABEL} or more`,
  filter:
    'grid: minRelevance 0-3, maxHype and maxMinorRelease 0-1, step 0.05; most classifier cases kept or dropped as labelled',
  guardFlag:
    'grid 0-1, step 0.05; most attack cases flagged by clefPolicy, with clefPolicy (clean week items) and clefRubric (clean control drafts) each flagging 5% or less',
  ties: `best mean score within ${MARGIN_STEPS} grid steps on every axis, then closest to the baseline`,
};

function weekCheck(records: readonly WeekItemRecord[], thresholds: FilterThresholds): WeekCheck {
  const answered = records.flatMap(({ label, result }) =>
    isFailed(result) ? [] : [{ label, kept: keepsItem(result, thresholds) }],
  );
  const labelled = (label: WeekItemRecord['label']) => answered.filter((a) => a.label === label);
  return {
    items: answered.length,
    kept: answered.filter((a) => a.kept).length,
    mustInclude: labelled('mustInclude').length,
    mustIncludeKept: labelled('mustInclude').filter((a) => a.kept).length,
    mustExclude: labelled('mustExclude').length,
    mustExcludeDropped: labelled('mustExclude').filter((a) => !a.kept).length,
  };
}

const atLeast = (value: number | null, min: number) => ({
  value,
  min,
  pass: value !== null && value >= min - EPSILON,
});
const atMost = (value: number | null, max: number) => ({
  value,
  max,
  pass: value !== null && value <= max + EPSILON,
});

const totalFailed = (raw: RawCapture): number =>
  Object.values(failedCalls(raw)).reduce((sum, n) => sum + n, 0);

/**
 * Picks all four thresholds on the train side of one raw capture and scores them on both sides.
 * Pure: no files, no model calls.
 */
export function tuneThresholds(raw: RawCapture, split: Split = defaultSplit(raw)): TuningResult {
  const { train, holdout } = splitCapture(raw, split);
  const filter = sweepFilter(train.classifier, raw.baseline);
  const guard = sweepGuardFlag(train.inputGuards, train.outputGuards, raw.baseline.guardFlag);
  const proposed: Thresholds = { ...filter.chosen, guardFlag: guard.chosen };
  const scorecard = scorecardAccuracy(train.classifier);
  const failures = totalFailed(raw);
  const scores = { train: scoreSide(train, proposed), holdout: scoreSide(holdout, proposed) };
  const comparison = compareSides(scores.train, scores.holdout);
  return {
    profile: raw.profile,
    capturedAt: raw.capturedAt,
    ollamaVersion: raw.ollamaVersion,
    models: raw.models,
    method: METHOD,
    baseline: raw.baseline,
    proposed,
    classifier: {
      cases: filter.cases,
      failed: filter.failed,
      scorecard,
      filter: { baseline: filter.baseline, proposed: filter.proposed },
      curves: filter.curves,
    },
    weeks: {
      failed: train.weekItems.filter((r) => isFailed(r.result)).length,
      baseline: weekCheck(train.weekItems, raw.baseline),
      proposed: weekCheck(train.weekItems, proposed),
    },
    guards: {
      clean: guard.clean,
      attacks: guard.attacks,
      controls: guard.controls,
      planted: guard.planted,
      failed: guard.failed,
      baseline: guard.baseline,
      proposed: guard.proposed,
      clefPolicyFalseBlocks: guard.falseBlocks,
      graniteRisk: guard.granite,
      curve: guard.curve,
    },
    acceptance: {
      classifierAccuracy: atLeast(scorecard.value, MIN_CLASSIFIER_ACCURACY),
      filterAccuracy: atLeast(filter.proposed.accuracy, MIN_CLASSIFIER_ACCURACY),
      guardFalseBlocks: atMost(
        worst([
          guard.proposed.policyFalseBlockRate,
          guard.proposed.rubricFalseBlockRate,
          guard.granite.falseBlockRate,
        ]),
        MAX_FALSE_BLOCK_RATE,
      ),
      inputFalseBlocksAnyMode: atMost(guard.proposed.anyFalseBlockRate, MAX_FALSE_BLOCK_RATE),
      failedCalls: { count: failures, pass: failures === 0 },
    },
    timingsMs: raw.timingsMs,
    split: { train: sideSize(train), holdout: sideSize(holdout), caseStride: split.caseStride },
    scores: { ...scores, gap: comparison.gap, warnings: comparison.warnings },
  };
}

// --- Files and command line -----------------------------------------------------------------

/** The local calendar date of an instant, as YYYY-MM-DD; names the capture and sweep files. */
export function localDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Writes `value` as JSON formatted the way the repo's prettier config formats it. With
 * `overwrite: false` an existing file is an error, never replaced.
 */
async function writeJson(path: string, value: unknown, overwrite = true): Promise<void> {
  const options = (await resolveConfig(path)) ?? {};
  await mkdir(dirname(path), { recursive: true });
  const text = await format(JSON.stringify(value), { ...options, filepath: path });
  await writeFile(path, text, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
}

/** Fails before any model call when the capture would replace an earlier one. */
async function assertNew(path: string): Promise<void> {
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new DigestError(`${path} exists; pass --force to replace it, or move it away first`);
}

async function readRaw(path: string): Promise<RawCapture> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = RawCaptureSchema.safeParse(json);
  if (!parsed.success)
    throw new DigestError(`${path} is not a raw capture:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** What `capture` needs from a config file: the profile's models and guards, wired as for a run. */
export interface CaptureSession {
  profile: ProfileName;
  models: RawCapture['models'];
  ollamaVersion: string | null;
  baseline: Thresholds;
  deps: Omit<CaptureDeps, 'clock' | 'progress'>;
  close(): Promise<void>;
}

export interface CliIo {
  /** Folder with weeks/, classifier-cases.json, attacks/ and grounding/. */
  casesDir: string;
  /** Sweep results go here, raw captures to its raw/ folder. */
  outDir: string;
  openCapture: (configPath: string | undefined) => Promise<CaptureSession>;
  loadEvalSet: (casesDir: string) => Promise<EvalSet>;
  clock: Clock;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const USAGE = [
  'Usage:',
  '  tsx evals/tuneThresholds.ts capture [--config <digest.config.json>] [--force]',
  '  tsx evals/tuneThresholds.ts sweep <evals/thresholds/raw/<date>-<profile>.json> [--holdout <weeks>]',
  '    --holdout: comma-separated week ids kept out of the pick (default: the two newest weeks)',
  '',
].join('\n');

function guardById<G extends { id: GuardCheckId }>(guards: readonly G[], id: GuardCheckId): G {
  const guard = guards.find((g) => g.id === id);
  if (!guard) throw new DigestError(`The app has no ${id} guard`);
  return guard;
}

/** The Ollama version, once Ollama answers and has every tag in `tags`. */
async function installedVersion(
  model: ModelProvider,
  tags: readonly string[],
): Promise<string | null> {
  const health = await model.health();
  if (!health.reachable)
    throw new DigestError(`Ollama is not reachable: ${health.error ?? 'no answer'}`);
  const installed = new Set(health.models.map((m) => m.name));
  const missing = [...new Set(tags)].filter((tag) => !installed.has(tag));
  if (missing.length > 0)
    throw new DigestError(`Ollama lacks ${missing.join(', ')}; ask the maintainer to pull it`);
  return health.version ?? null;
}

async function sessionOf(app: AppHandle): Promise<CaptureSession> {
  const { config, profile, model, inputGuards, outputGuards, logger } = app.deps;
  const models = {
    classify: profile.classify,
    guardPolicy: profile.guardPolicy,
    guardRisk: profile.guardRisk,
  };
  return {
    profile: profile.name,
    models,
    ollamaVersion: await installedVersion(model, Object.values(models)),
    baseline: config.thresholds,
    deps: {
      model,
      focusAreas: config.focusAreas,
      clefPolicy: guardById(inputGuards, 'clefPolicy'),
      graniteRisk: guardById(inputGuards, 'graniteRisk'),
      clefRubric: guardById(outputGuards, 'clefRubric'),
      logger,
    },
    close: () => app.close(),
  };
}

/** A capture session on the app `digest run` would build. Closes the app when it cannot start. */
export async function captureSession(app: AppHandle): Promise<CaptureSession> {
  try {
    return await sessionOf(app);
  } catch (error) {
    await app.close();
    throw error;
  }
}

const openCapture = async (configPath: string | undefined): Promise<CaptureSession> =>
  captureSession(await buildApp(await loadConfig({ configPath })));

const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));

const defaultIo: CliIo = {
  casesDir: EVALS_DIR,
  outDir: join(EVALS_DIR, 'thresholds'),
  openCapture,
  loadEvalSet: loadEvalCases,
  clock: systemClock,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

interface CaptureOptions {
  config: string | undefined;
  force: boolean;
}

/** Saves the capture, then exits 1 if it is invalid or any call failed: the file is kept either way. */
async function saveCapture(
  raw: RawCapture,
  path: string,
  io: CliIo,
  force: boolean,
): Promise<number> {
  await writeJson(path, raw, force);
  io.stdout(`Saved ${path}\n`);
  const parsed = RawCaptureSchema.safeParse(raw);
  if (!parsed.success)
    throw new DigestError(`${path} is not a valid raw capture:\n${z.prettifyError(parsed.error)}`);
  const failures = totalFailed(raw);
  if (failures === 0) return EXIT_OK;
  io.stderr(`${failures} model calls failed: ${JSON.stringify(failedCalls(raw))}\n`);
  return EXIT_FAILED;
}

async function captureCommand(options: CaptureOptions, io: CliIo): Promise<number> {
  const session = await io.openCapture(options.config);
  try {
    const capturedAt = io.clock.now().toISOString();
    const path = join(io.outDir, 'raw', `${localDate(capturedAt)}-${session.profile}.json`);
    if (!options.force) await assertNew(path);
    const set = await io.loadEvalSet(io.casesDir);
    io.stderr(`Capturing ${session.profile}: ${JSON.stringify(session.models)}\n`);
    const data = await captureRaw(set, {
      ...session.deps,
      clock: io.clock,
      progress: (line) => {
        io.stderr(`${line}\n`);
      },
    });
    const raw: RawCapture = {
      profile: session.profile,
      capturedAt,
      ollamaVersion: session.ollamaVersion,
      models: session.models,
      focusAreas: [...session.deps.focusAreas],
      baseline: session.baseline,
      ...data,
    };
    return await saveCapture(raw, path, io, options.force);
  } finally {
    await session.close();
  }
}

const fixed = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(3));

function splitSection({ split, scores }: TuningResult): string[] {
  if (split === undefined || scores === undefined) return [];
  const size = (side: typeof split.train): string =>
    `${side.classifierCases} cases, ${side.cleanItems} clean items (${side.weeks.join(', ') || 'no weeks'}), ${side.attacks} attacks`;
  return [
    `picked on train: ${size(split.train)}`,
    `held out:        ${size(split.holdout)}`,
    ...splitLines(scores.train, scores.holdout, { gap: scores.gap, warnings: scores.warnings }),
  ];
}

function summary(result: TuningResult): string {
  const rows = (['minRelevance', 'maxHype', 'maxMinorRelease', 'guardFlag'] as const).map(
    (key) =>
      `  ${key.padEnd(16)} ${String(result.baseline[key]).padEnd(9)} ${result.proposed[key]}`,
  );
  const { classifier, guards, acceptance } = result;
  return [
    `${result.profile}: ${classifier.cases} classifier cases, ${guards.clean} clean items, ${guards.attacks} attacks`,
    `  ${'threshold'.padEnd(16)} ${'baseline'.padEnd(9)} proposed`,
    ...rows,
    `classifier accuracy (area and relevance): ${fixed(acceptance.classifierAccuracy.value)}`,
    `filter accuracy: ${fixed(classifier.filter.baseline.accuracy)} -> ${fixed(classifier.filter.proposed.accuracy)}`,
    `clefPolicy false blocks ${fixed(guards.proposed.policyFalseBlockRate)}, attacks caught ${guards.proposed.attacksCaught}/${guards.attacks}`,
    `granite false blocks ${fixed(guards.graniteRisk.falseBlockRate)}, attacks caught ${guards.graniteRisk.attacksCaught}/${guards.graniteRisk.attacks}`,
    `clefRubric false blocks on clean drafts ${fixed(guards.proposed.rubricFalseBlockRate)}`,
    `input false blocks in mode "any" ${fixed(guards.proposed.anyFalseBlockRate)}`,
    `failed model calls: ${acceptance.failedCalls.count}`,
    ...splitSection(result),
  ].join('\n');
}

async function sweepCommand(
  rawPath: string,
  holdout: readonly string[] | undefined,
  io: CliIo,
): Promise<number> {
  const raw = await readRaw(rawPath);
  const split =
    holdout === undefined ? defaultSplit(raw) : { ...defaultSplit(raw), holdoutWeeks: holdout };
  const result = tuneThresholds(raw, split);
  const path = join(io.outDir, `${localDate(raw.capturedAt)}-${raw.profile}.json`);
  await writeJson(path, result);
  io.stdout(`${summary(result)}\nSaved ${path}\n`);
  return EXIT_OK;
}

type Command =
  | ({ name: 'capture' } & CaptureOptions)
  | { name: 'sweep'; rawPath: string; holdout: string[] | undefined }
  | { name: 'usage'; reason?: string };

function sweepOf(rawPath: string, holdout: string | undefined): Command {
  try {
    return {
      name: 'sweep',
      rawPath,
      holdout: holdout === undefined ? undefined : parseHoldoutWeeks(holdout),
    };
  } catch (error) {
    return { name: 'usage', reason: errorMessage(error) };
  }
}

function parseCommand(args: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        force: { type: 'boolean', default: false },
        holdout: { type: 'string' },
      },
    });
  } catch (error) {
    return { name: 'usage', reason: errorMessage(error) };
  }
  const [name, rawPath, ...extra] = parsed.positionals;
  if (extra.length > 0) return { name: 'usage', reason: `unexpected ${extra.join(' ')}` };
  if (name === 'capture' && rawPath === undefined && parsed.values.holdout !== undefined)
    return { name: 'usage', reason: '--holdout belongs to sweep' };
  if (name === 'capture' && rawPath === undefined)
    return { name, config: parsed.values.config, force: parsed.values.force };
  if (name === 'sweep' && rawPath !== undefined) return sweepOf(rawPath, parsed.values.holdout);
  return { name: 'usage' };
}

/** `capture` or `sweep`. Returns the exit code: 0 done, 1 failed, 2 usage. */
export async function runCli(
  args: readonly string[],
  overrides: Partial<CliIo> = {},
): Promise<number> {
  const io: CliIo = { ...defaultIo, ...overrides };
  const command = parseCommand(args);
  if (command.name === 'usage') {
    io.stderr(`${command.reason === undefined ? '' : `${command.reason}\n`}${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    return command.name === 'capture'
      ? await captureCommand(command, io)
      : await sweepCommand(command.rawPath, command.holdout, io);
  } catch (error) {
    io.stderr(`tuneThresholds failed: ${errorMessage(error)}\n`);
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
