// Offline eval: replays the recorded weeks through runDigest, runs the case sets through the
// steps and guards, and returns the scorecard (W1-22). Models, guards and the digest runner are
// injected, so tests use fakes and `digest eval` wires the real ones.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppHandle } from '../src/app/container';
import { modelsByRole } from '../src/config/profiles';
import { GuardsConfigSchema, type ProfileName } from '../src/config/schema';
import type { DigestDeps, RunOptions, RunResult } from '../src/digest/runDigest';
import {
  ItemSchema,
  SourceKindSchema,
  WEEK_ID_PATTERN,
  type Draft,
  type Item,
  type Source,
} from '../src/domain/schemas';
import { type GuardCheckId, type GuardVerdict } from '../src/guards/guardVerdict';
import { type RunRecord } from '../src/store/runRecord';
import { areaHintsOf, classifyStep } from '../src/classify/classify';
import { guardOutputStep } from '../src/guards/guardOutput';
import type { InputGuard, OutputGuard } from '../src/guards/Guard';
import type { RunStore } from '../src/store/RunStore';
import type { FetchWindow } from '../src/sources/SourceFetcher';
import { fixedClock, type Clock } from '../src/shared/clock';
import { DigestError, errorMessage } from '../src/shared/errors';
import { compareWeekIds, isoWeekId, weekStartUtc } from '../src/shared/isoWeek';
import { normalizeUrl, sameUrl } from '../src/shared/url';
import { createCheckpoints, fingerprintOf, type Checkpoints } from './checkpoint';
import { replayCodec } from './checkpointReplay';
import {
  notRun,
  SECTION_METRICS,
  type EvalSection,
  type SavedScorecard,
} from './checkpointSections';
import type { EvalJudge } from './judge/evalJudge';
import { judgeWinners, judgedQuality, type JudgedWinners } from './judge/judgeWinners';
import {
  assembleMetrics,
  attackHandling,
  attackRunMeasurement,
  classifierRanking,
  digestItemIds,
  failedHardGates,
  formatCompliance,
  groundedness,
  guardAttackRecall,
  sourceParse,
  sourceSummaryFill,
  guardFalseBlocks,
  guardRealBlocks,
  linkValidity,
  mustExcludeLeaks,
  mustIncludeRecall,
  noDigestCause,
  runTime,
  stability,
  withCoverage,
  writerWinRate,
  writingQuality,
  type AttackOutcome,
  type ClassifierResult,
  type DigestSample,
  type GroundingOutcome,
  type GuardTally,
  type Measurement,
  type ReplayEnd,
  type WeekHits,
} from './metrics';
import {
  defaultFetcherFactories,
  evaluateSources,
  loadSourceRecordings,
  type SourceFetcherFactories,
  type SourceRecording,
  type SourceResult,
} from './sourceEval';
import {
  AttackCaseSchema,
  ClassifierCasesFileSchema,
  GroundingCaseSchema,
  JudgeCalibrationSchema,
  WeekLabelsSchema,
  withoutItem,
  type AttackCase,
  type ClassifierCase,
  type GroundingCase,
  type JudgeCalibration,
  type MetricId,
  type MetricResult,
  type WeekDetail,
  type WeekLabels,
} from './schema';

const DAY_MS = 86_400_000;
/** Recorded weeks are ISO weeks, so each replay collects exactly one week. */
const WEEK_DAYS = 7;
/** Spec: the same week is run 3 times to measure stability. */
const STABILITY_RUNS = 3;
/** Attack items are dated just before the end of the replayed week: newest, so worst case. */
const ATTACK_LEAD_MS = 1000;
/** Spec: must-include recall is counted in the top 5, whatever topN the local config says. */
const REPLAY_TOP_N = 5;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** How many of each kind of case a set has. */
export interface EvalSetSize {
  weeks: number;
  attacks: number;
  grounding: number;
  classifier: number;
}

/** Spec: 6 recorded weeks, 10 attack cases, 10 grounding cases, 60 classifier cases. */
export const SPEC_EVAL_SET: EvalSetSize = { weeks: 6, attacks: 30, grounding: 30, classifier: 60 };

export interface EvalOptions {
  profile: ProfileName;
  /** Folder with weeks/, classifier-cases.json, attacks/, grounding/ and judge/. */
  casesDir: string;
  /** A hard gate fails on a smaller set. Default: the spec's set; lower it while cases are written. */
  minimums?: EvalSetSize;
  /** Run one section and save a partial scorecard. Default: every section. */
  only?: EvalSection;
  /** Save each week replay under `dir`; with `resume`, reuse the ones already there. */
  checkpoints?: { dir: string; resume: boolean; gitSha: string };
}

export interface EvalDeps {
  /** Builds the app for a profile; runEval closes it when done. */
  buildApp: (profile: ProfileName) => Promise<AppHandle>;
  runDigest: (deps: DigestDeps, options: RunOptions) => Promise<RunResult>;
  /** Wall clock for dates and timings. Replays use their own fixed clock. */
  clock: Clock;
  /**
   * Scores the winning draft of each replayed week when the profile has no judge of its own
   * (`EVAL_JUDGE`, system-design D16). Without it, writing quality stays unmeasured there.
   */
  judge?: EvalJudge;
  /** Fetchers run over the source recordings. Default: the real RSS and GitHub fetchers. */
  sourceFetchers?: SourceFetcherFactories;
}

// --- Loading the eval set -------------------------------------------------------------------

export interface EvalWeek {
  weekId: string;
  items: Item[];
  labels: WeekLabels;
}

export interface EvalCases {
  weeks: EvalWeek[];
  classifier: { reviewed: boolean; cases: ClassifierCase[] };
  attacks: AttackCase[];
  grounding: GroundingCase[];
  calibration: JudgeCalibration | null;
  sources: SourceRecording[];
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** undefined when the file does not exist; a DigestError that names the file when it is bad. */
async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DigestError(`${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DigestError(`${path} does not match its schema:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function requireJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const value = await readJson(path, schema);
  if (value === undefined) throw new DigestError(`${path} is missing`);
  return value;
}

async function requireFolder(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    const reason = isNotFound(error) ? 'not found' : errorMessage(error);
    throw new DigestError(`Eval folder ${path}: ${reason}`, { cause: error });
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw new DigestError(`Cannot read ${dir}: ${errorMessage(error)}`, { cause: error });
  }
}

async function loadWeek(weeksDir: string, weekId: string): Promise<EvalWeek> {
  const dir = join(weeksDir, weekId);
  const itemsPath = join(dir, 'items.json');
  const items = await requireJson(itemsPath, z.array(ItemSchema));
  const stray = items.filter((item) => isoWeekId(new Date(item.publishedAt)) !== weekId);
  if (stray.length > 0) {
    throw new DigestError(
      `${itemsPath}: ${stray.length} item(s) were not published in ${weekId}, for example ${stray[0]?.id}`,
    );
  }
  const labelsPath = join(dir, 'labels.json');
  const labels = await requireJson(labelsPath, WeekLabelsSchema);
  const known = new Set(items.map((item) => item.id));
  const unknown = [...labels.mustInclude, ...labels.mustExclude].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new DigestError(`${labelsPath}: ids not in items.json: ${unknown.join(', ')}`);
  }
  return { weekId, items, labels };
}

/** Like the real fetchers: a source's newest items first. */
function newestFirst(items: readonly Item[]): Item[] {
  return items.toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/**
 * The ids a replay serves: each source's newest items up to the cap production applies to it,
 * `maxItems` of its own else `maxItemsPerSource`. A label outside this set is "not visible".
 */
function servedIds(
  items: readonly Item[],
  sources: readonly Source[],
  maxItemsPerSource: number,
): Set<string> {
  const served = new Set<string>();
  for (const sourceId of new Set(items.map((item) => item.sourceId))) {
    const cap = sources.find((source) => source.id === sourceId)?.maxItems ?? maxItemsPerSource;
    const own = items.filter((item) => item.sourceId === sourceId);
    for (const item of newestFirst(own).slice(0, cap)) served.add(item.id);
  }
  return served;
}

async function loadWeeks(weeksDir: string): Promise<EvalWeek[]> {
  const weekIds = (await listNames(weeksDir))
    .filter((name) => WEEK_ID_PATTERN.test(name))
    .sort(compareWeekIds);
  const weeks: EvalWeek[] = [];
  for (const weekId of weekIds) weeks.push(await loadWeek(weeksDir, weekId));
  return weeks;
}

/** One JSON file per case; ids must be unique. */
async function loadCaseDir<T extends { id: string }>(
  dir: string,
  schema: z.ZodType<T>,
  kind: string,
): Promise<T[]> {
  const names = (await listNames(dir)).filter((name) => name.endsWith('.json'));
  const cases: T[] = [];
  for (const name of names) cases.push(await requireJson(join(dir, name), schema));
  const ids = cases.map((c) => c.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new DigestError(`${dir}: duplicate ${kind} id "${duplicate}"`);
  return cases;
}

/** An attack item must be its own item: a shared id or URL would be deduped before the guards. */
function assertAttacksAreDistinct(
  attacks: readonly AttackCase[],
  weeks: readonly EvalWeek[],
): void {
  const owners = new Map<string, string>();
  for (const week of weeks) {
    for (const item of week.items) {
      owners.set(`id ${item.id}`, week.weekId);
      owners.set(`URL ${normalizeUrl(item.url)}`, week.weekId);
    }
  }
  for (const attack of attacks) {
    for (const key of [`id ${attack.item.id}`, `URL ${normalizeUrl(attack.item.url)}`]) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new DigestError(`attack ${attack.id} shares its ${key.split(' ')[0]} with ${owner}`);
      }
      owners.set(key, `attack ${attack.id}`);
    }
  }
}

/**
 * Everything the eval needs from disk. A missing cases folder throws; missing case folders and
 * files inside it are empty sets (a hard gate then cannot pass). Bad files throw, naming the file.
 */
export async function loadEvalCases(casesDir: string): Promise<EvalCases> {
  await requireFolder(casesDir);
  const classifier = await readJson(
    join(casesDir, 'classifier-cases.json'),
    ClassifierCasesFileSchema,
  );
  const weeks = await loadWeeks(join(casesDir, 'weeks'));
  const attacks = await loadCaseDir(join(casesDir, 'attacks'), AttackCaseSchema, 'attack');
  assertAttacksAreDistinct(attacks, weeks);
  return {
    weeks,
    classifier: classifier ?? { reviewed: false, cases: [] },
    attacks,
    grounding: await loadCaseDir(join(casesDir, 'grounding'), GroundingCaseSchema, 'grounding'),
    calibration:
      (await readJson(join(casesDir, 'judge', 'calibration.json'), JudgeCalibrationSchema)) ?? null,
    sources: await loadSourceRecordings(join(casesDir, 'sources')),
  };
}

// --- Replaying a week -----------------------------------------------------------------------

/** Run store that keeps everything in memory: replays must not touch data/. */
export function createEvalStore(): RunStore {
  const artifacts = new Map<string, string>();
  const records = new Map<string, RunRecord>();
  return {
    acquireLock: () => Promise.resolve({ release: () => Promise.resolve() }),
    hasSentDigest: (runId) => Promise.resolve(records.get(runId)?.status === 'sent'),
    saveArtifact: (runId, name, content) => {
      artifacts.set(`${runId}/${name}`, content);
      return Promise.resolve();
    },
    readArtifact: (runId, name) => Promise.resolve(artifacts.get(`${runId}/${name}`)),
    saveRunRecord: (record) => {
      records.set(record.runId, record);
      return Promise.resolve();
    },
    getRunRecord: (runId) => Promise.resolve(records.get(runId)),
    // Replays are independent weeks: nothing counts as already sent.
    sentUrls: () => Promise.resolve(new Set<string>()),
    listRuns: (limit = Number.POSITIVE_INFINITY) =>
      Promise.resolve(
        [...records.values()].sort((a, b) => compareWeekIds(b.runId, a.runId)).slice(0, limit),
      ),
    prune: () => Promise.resolve([]),
  };
}

interface InputVerdict {
  guardId: GuardCheckId;
  itemId: string;
  verdict: GuardVerdict;
}

interface OutputVerdict {
  draft: Draft;
  verdict: GuardVerdict;
}

/** Same guards, but every verdict is also pushed to `log` (the recorder's own accumulator). */
function recordInputGuards(guards: readonly InputGuard[], log: InputVerdict[]): InputGuard[] {
  return guards.map((guard) => ({
    id: guard.id,
    checkItem: async (item, options) => {
      const verdict = await guard.checkItem(item, options);
      log.push({ guardId: guard.id, itemId: item.id, verdict });
      return verdict;
    },
  }));
}

function recordOutputGuards(guards: readonly OutputGuard[], log: OutputVerdict[]): OutputGuard[] {
  return guards.map((guard) => ({
    id: guard.id,
    checkDraft: async (draft, sources, options) => {
      const verdict = await guard.checkDraft(draft, sources, options);
      log.push({ draft, verdict });
      return verdict;
    },
  }));
}

/** The week's end: the replay clock, so the collect window is exactly the recorded week. */
function endOfWeek(weekId: string): Date {
  return new Date(weekStartUtc(weekId).getTime() + WEEK_DAYS * DAY_MS - 1);
}

/**
 * One source per source id found in the recorded items; the url is never fetched. A source
 * keeps the `maxItems` the allowlist gives it, and one with none falls back to the config's
 * `maxItemsPerSource`, so the cap is production's own.
 */
function sourcesOf(items: readonly Item[], allowlist: readonly Source[]): Source[] {
  const firstOfSource = new Map(items.map((item) => [item.sourceId, item]));
  return [...firstOfSource.values()].map((item) => {
    const maxItems = allowlist.find((source) => source.id === item.sourceId)?.maxItems;
    return {
      id: item.sourceId,
      kind: item.kind,
      url: item.url,
      ...(maxItems === undefined ? {} : { maxItems }),
    };
  });
}

function recordedFetchers(items: readonly Item[]): DigestDeps['fetchers'] {
  return Object.fromEntries(
    SourceKindSchema.options.map((kind) => [
      kind,
      {
        kind,
        // Like the real fetchers: this source's newest items, at most `maxItems`.
        fetch: (source: Source, window: FetchWindow) =>
          Promise.resolve(
            newestFirst(items.filter((item) => item.sourceId === source.id)).slice(
              0,
              window.maxItems,
            ),
          ),
      },
    ]),
  );
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
async function replay(
  app: DigestDeps,
  deps: EvalDeps,
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

const idsOf = (run: Replay): string[] =>
  run.markdown === undefined ? [] : digestItemIds(run.markdown, run.items);

const sampleOf = (run: Replay): DigestSample => ({
  weekId: run.weekId,
  markdown: run.markdown,
  items: run.items,
  ...(run.markdown === undefined ? { cause: noDigestCause(run.record) } : {}),
});

const replayEndOf = (run: Replay): ReplayEnd => ({
  label: run.weekId,
  status: run.record.status,
  drafts: run.record.drafts,
  outputVerdicts: run.outputVerdicts.map(({ verdict }) => ({
    check: verdict.check,
    flagged: verdict.flagged,
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
  })),
});

// --- Attacks, classifier and grounding ------------------------------------------------------

function mentionsUrl(markdown: string, url: string): boolean {
  const found = markdown.match(URL_IN_TEXT) ?? [];
  return (
    markdown.includes(url) ||
    found.some((candidate) => sameUrl(candidate.replace(TRAILING_PUNCTUATION, ''), url))
  );
}

/** An attack reaches the digest when its URL or its title appears anywhere in the text. */
function reachesDigest(item: Item, run: Replay): boolean {
  if (run.markdown === undefined) return false;
  const title = item.title.trim();
  return mentionsUrl(run.markdown, item.url) || (title !== '' && run.markdown.includes(title));
}

const flaggedChecks = (verdicts: readonly GuardVerdict[]): GuardCheckId[] => [
  ...new Set(verdicts.filter((v) => v.flagged).map((v) => v.check)),
];

/** One extra replay of `base` with every attack item mixed in, dated into the replayed week. */
async function replayAttacks(
  app: DigestDeps,
  deps: EvalDeps,
  base: EvalWeek,
  attacks: readonly AttackCase[],
): Promise<{ run: Replay; outcomes: AttackOutcome[] }> {
  const publishedAt = new Date(endOfWeek(base.weekId).getTime() - ATTACK_LEAD_MS).toISOString();
  const injected = attacks.map((attack) => ({ ...attack.item, publishedAt }));
  const run = await replay(app, deps, base.weekId, [...base.items, ...injected]);
  const alone = await flaggedAlone(app, run, injected);
  const outcomes = attacks.map((attack) => {
    const verdicts = run.inputVerdicts.filter((v) => v.itemId === attack.item.id);
    return {
      caseId: attack.id,
      reachedDigest: reachesDigest(attack.item, run),
      evaluated: verdicts.length > 0,
      blockedBy: flaggedChecks(verdicts.map((v) => v.verdict)),
      flaggedAlone: alone.get(attack.item.id) ?? [],
    };
  });
  return { run, outcomes };
}

/**
 * What each enabled input guard flags on every attack item on its own, whatever the guard mode.
 * In mode "any" the pipeline never shows a later guard an item an earlier one flagged, so the
 * missing verdicts are asked here, one guard after the other so only one model is loaded at a
 * time. A verdict the pipeline already got is reused. Record only: the run itself is unchanged.
 */
async function flaggedAlone(
  app: DigestDeps,
  run: Replay,
  items: readonly Item[],
): Promise<Map<string, GuardCheckId[]>> {
  const flagged = new Map<string, GuardCheckId[]>();
  const enabled = app.inputGuards.filter((g) => !run.record.disabledGuards.includes(g.id));
  for (const guard of enabled) {
    for (const item of items) {
      const seen = run.inputVerdicts.find((v) => v.guardId === guard.id && v.itemId === item.id);
      const verdict = seen?.verdict ?? (await guard.checkItem(item));
      if (verdict.flagged) flagged.set(item.id, [...(flagged.get(item.id) ?? []), guard.id]);
    }
  }
  return flagged;
}

async function classifyCases(
  app: DigestDeps,
  cases: readonly ClassifierCase[],
): Promise<ClassifierResult[]> {
  if (cases.length === 0) return [];
  const scored = await classifyStep(
    cases.map((c) => c.item),
    {
      model: app.model,
      focusAreas: app.config.focusAreas,
      logger: app.logger,
      areaHints: areaHintsOf(app.config.sources),
    },
  );
  if (scored.length !== cases.length) {
    throw new DigestError(`classify returned ${scored.length} results for ${cases.length} cases`, {
      step: 'classify',
    });
  }
  return cases.flatMap((c, i) => {
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
}

function tallyOf(verdicts: readonly GuardVerdict[]): Partial<Record<GuardCheckId, GuardTally>> {
  return verdicts.reduce<Partial<Record<GuardCheckId, GuardTally>>>((tallies, verdict) => {
    const before = tallies[verdict.check] ?? { checked: 0, flagged: 0 };
    return {
      ...tallies,
      [verdict.check]: {
        checked: before.checked + 1,
        flagged: before.flagged + (verdict.flagged ? 1 : 0),
      },
    };
  }, {});
}

interface GroundingResults {
  outcomes: GroundingOutcome[];
  /** False blocks of the output guards on the clean control drafts. */
  tallies: Partial<Record<GuardCheckId, GuardTally>>;
  /** Output checks that did not run (switched off or no guard supplied). */
  disabledChecks: GuardCheckId[];
}

/** Each planted draft goes through the output guards together with its clean control. */
async function checkGrounding(
  app: DigestDeps,
  cases: readonly GroundingCase[],
): Promise<GroundingResults> {
  const log: OutputVerdict[] = [];
  const config = GuardsConfigSchema.parse({}).output;
  const guardDeps = {
    guards: recordOutputGuards(app.outputGuards, log),
    config,
    logger: app.logger,
  };
  const outcomes: GroundingOutcome[] = [];
  const controls: Draft[] = [];
  let disabledChecks: GuardCheckId[] = [];
  for (const c of cases) {
    const control = withoutItem(c.draft, c.plantedItemId);
    if (control) controls.push(control);
    const { rejected, disabledChecks: disabled } = await guardOutputStep(
      control ? [c.draft, control] : [c.draft],
      c.sources,
      guardDeps,
    );
    disabledChecks = disabled;
    outcomes.push({
      caseId: c.id,
      caught: rejected.some((r) => r.draft === c.draft),
      flaggedBy: flaggedChecks(log.filter((v) => v.draft === c.draft).map((v) => v.verdict)),
    });
  }
  const controlVerdicts = log.filter((v) => controls.includes(v.draft)).map((v) => v.verdict);
  return { outcomes, tallies: tallyOf(controlVerdicts), disabledChecks };
}

// --- Scoring --------------------------------------------------------------------------------

interface WeekRun {
  week: EvalWeek;
  run: Replay;
}

interface StabilityWeek {
  weekId: string;
  runs: string[][];
  /** The replays behind `runs`, the first one included. */
  replays: Replay[];
}

interface AttackReplay {
  run: Replay;
  outcomes: AttackOutcome[];
}

interface EvalRun {
  weekRuns: WeekRun[];
  /** Digest item ids of each run of every week, the plain replay included. */
  stabilityIds: StabilityWeek[];
  attack: AttackReplay | undefined;
  /** The plain replay of the first week, the attack replay's baseline; run for `guards` alone. */
  attackBaseline: Replay | undefined;
  classifier: ClassifierResult[];
  grounding: GroundingResults;
  /** The eval judge's scores of the winners; undefined when it was never asked. */
  judged: JudgedWinners | undefined;
  /** One result per recorded source; measured before any model call. */
  sources: SourceResult[];
}

function winnerScore(record: RunRecord): number | undefined {
  return record.drafts.find((draft) => draft.writer === record.winner)?.score?.score;
}

/** The first week's plain replay is the baseline the attack replay is compared with. */
function attackMeasurement(
  attack: AttackReplay | undefined,
  baseline: Replay | undefined,
): Measurement {
  if (!attack) return attackHandling([]);
  const { status, disabledGuards, drafts } = attack.run.record;
  return attackRunMeasurement(
    { status, disabledGuards, drafts, baselineStatus: baseline?.record.status },
    attack.outcomes,
  );
}

function groundingMeasurement(grounding: GroundingResults): Measurement {
  if (grounding.disabledChecks.length > 0) {
    return { value: null, note: `guards were off: ${grounding.disabledChecks.join(', ')}` };
  }
  return groundedness(grounding.outcomes);
}

interface Scoring {
  profile: ProfileName;
  only: EvalSection | undefined;
  cases: EvalCases;
  run: EvalRun;
  app: DigestDeps;
  minimums: EvalSetSize;
  startMs: number;
  endMs: number;
}

/** The judge's calibration only means something for a profile that has a judge. */
const calibrationFor = ({ app, cases }: Scoring): JudgeCalibration | null =>
  app.profile.judge === null ? null : cases.calibration;

/** One week for the recall and leak metrics: its labels, its digest and what the replay served. */
function hitsOf({ week, run }: WeekRun): WeekHits {
  return {
    mustInclude: week.labels.mustInclude,
    mustExclude: week.labels.mustExclude,
    digestItemIds: idsOf(run),
    visibleIds: run.served,
  };
}

function measure(scoring: Scoring): Record<MetricId, Measurement> {
  const { cases, run, minimums } = scoring;
  const calibration = calibrationFor(scoring);
  const weekSamples = run.weekRuns.map(({ run: r }) => sampleOf(r));
  const attackSamples = run.attack
    ? [{ ...sampleOf(run.attack.run), label: `${run.attack.run.weekId} (attacks)` }]
    : [];
  const hits = run.weekRuns.map(hitsOf);
  const inputTallies = tallyOf(
    run.weekRuns.flatMap(({ run: r }) => r.inputVerdicts.map((v) => v.verdict)),
  );
  const records = run.weekRuns.map(({ run: r }) => r.record);
  const classifierCases = cases.classifier.cases.length;
  const unreviewed = classifierCases > 0 && !cases.classifier.reviewed;
  const weeks = (m: Measurement): Measurement =>
    withCoverage(m, cases.weeks.length, minimums.weeks, 'weeks');
  const attacks = (m: Measurement): Measurement =>
    withCoverage(m, cases.attacks.length, minimums.attacks, 'attack cases');
  return {
    linkValidity: weeks(linkValidity([...weekSamples, ...attackSamples])),
    attackHandling: attacks(
      attackMeasurement(run.attack, run.attackBaseline ?? run.weekRuns[0]?.run),
    ),
    sourceParse: sourceParse(run.sources),
    sourceSummaryFill: sourceSummaryFill(run.sources),
    guardAttackRecall: attacks(
      guardAttackRecall(run.attack?.outcomes ?? [], run.attack?.run.record.disabledGuards ?? []),
    ),
    groundedness: withCoverage(
      groundingMeasurement(run.grounding),
      cases.grounding.length,
      minimums.grounding,
      'grounding cases',
    ),
    format: weeks(formatCompliance(weekSamples)),
    guardFalseBlocks: guardFalseBlocks({ ...inputTallies, ...run.grounding.tallies }),
    guardRealBlocks: weeks(
      guardRealBlocks(run.stabilityIds.flatMap((w) => w.replays).map(replayEndOf)),
    ),
    mustIncludeRecall: weeks(mustIncludeRecall(hits)),
    mustExcludeLeaks: weeks(mustExcludeLeaks(hits)),
    classifierAccuracy: withCoverage(
      {
        ...classifierRanking(run.classifier),
        ...(unreviewed ? { note: 'labels not reviewed by the maintainer yet' } : {}),
      },
      classifierCases,
      minimums.classifier,
      'classifier cases',
    ),
    writingQuality: run.judged
      ? judgedQuality(run.judged)
      : writingQuality(records.flatMap((record) => winnerScore(record) ?? [])),
    // Measured once on the hand-graded digests (W3-04), not on every eval run.
    selectionAgreement: calibration
      ? { value: calibration.selectionAgreement, note: 'from judge/calibration.json' }
      : { value: null },
    writerWinRate: writerWinRate(records.flatMap((record) => record.winner ?? [])),
    stability: stabilityAcrossWeeks(run.stabilityIds),
    runTime: runTime(run.weekRuns.map(({ run: r }) => r.durationMs)),
  };
}

/** On a partial run, every metric outside the section is "not run": no value, no gate result. */
function withSectionOnly(
  metrics: Record<MetricId, MetricResult>,
  only: EvalSection | undefined,
): Record<MetricId, MetricResult> {
  if (only === undefined) return metrics;
  const measured = new Set<MetricId>(SECTION_METRICS[only]);
  return Object.fromEntries(
    Object.entries(metrics).map(([id, metric]) => [
      id,
      measured.has(metric.id) ? metric : notRun(metric, only),
    ]),
  ) as Record<MetricId, MetricResult>;
}

function buildScorecard(scoring: Scoring): SavedScorecard {
  const { profile, only, cases, run, app, startMs, endMs } = scoring;
  const judgeAgreement = calibrationFor(scoring)?.judgeAgreement ?? null;
  const metrics = withSectionOnly(assembleMetrics(measure(scoring), judgeAgreement), only);
  return {
    profile,
    date: new Date(startMs).toISOString(),
    weeks: cases.weeks.map((week) => week.weekId),
    counts: {
      weeks: cases.weeks.length,
      classifier: cases.classifier.cases.length,
      attacks: cases.attacks.length,
      grounding: cases.grounding.length,
      sources: cases.sources.length,
    },
    judgeAgreement,
    models: {
      ...modelsByRole(app.profile),
      ...(run.judged ? { evalJudge: run.judged.model } : {}),
    },
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    ...(only === undefined ? {} : { partial: [only] }),
    timings: {
      totalMs: Math.max(0, endMs - startMs),
      byWeekMs: Object.fromEntries(
        run.weekRuns.map(({ week, run: r }) => [week.weekId, r.durationMs]),
      ),
    },
  };
}

/**
 * The gate keeps its meaning: the value, the note, the detail and `itemIdsByRun` are the first
 * week's, as in the earlier scorecards. When more weeks were replayed, `byWeek` adds each week's
 * own overlap; a week with an empty run is `no-digest`, which the scorecard text lists.
 */
function stabilityAcrossWeeks(weeks: readonly StabilityWeek[]): Measurement {
  const [first] = weeks;
  if (!first) return stability([]);
  const base = stability(first.runs, first.weekId);
  if (weeks.length === 1) return base;
  const byWeek = Object.fromEntries(
    weeks.map(({ weekId, runs, replays }): [string, WeekDetail] => {
      const empty = runs.filter((ids) => ids.length === 0).length;
      const causes = replays.flatMap((r, i) =>
        runs[i]?.length === 0 ? [`run ${i + 1}: ${noDigestCause(r.record)}`] : [],
      );
      const overlap = stability(runs, weekId).value ?? 0;
      return [
        weekId,
        {
          status: empty === 0 ? 'ok' : 'no-digest',
          problems: [
            `overlap ${overlap.toFixed(2)} items over ${runs.length} runs, ${empty} empty`,
            ...causes,
          ],
          problemCount: empty,
        },
      ];
    }),
  );
  return { ...base, byWeek };
}

/** Checkpoints for one profile's replays; the fingerprint changes with the config or the git sha. */
function checkpointsFor(options: EvalOptions, app: DigestDeps): Checkpoints | undefined {
  const saved = options.checkpoints;
  if (!saved) return undefined;
  const fingerprint = fingerprintOf({
    gitSha: saved.gitSha,
    profile: options.profile,
    config: app.config,
    models: modelsByRole(app.profile),
  });
  return createCheckpoints({
    dir: saved.dir,
    fingerprint,
    resume: saved.resume,
    warn: (message) => {
      app.logger.warn(message);
    },
  });
}

async function evaluate(
  cases: EvalCases,
  app: DigestDeps,
  deps: EvalDeps,
  options: EvalOptions,
): Promise<EvalRun> {
  const wants = (section: EvalSection): boolean =>
    options.only === undefined || options.only === section;
  const checkpoints = checkpointsFor(options, app);
  const replayWeek = (week: EvalWeek, run: number): Promise<Replay> => {
    const compute = (): Promise<Replay> => replay(app, deps, week.weekId, week.items);
    return checkpoints
      ? checkpoints.resume(`${options.profile}.${week.weekId}.run${run}`, compute, replayCodec)
      : compute();
  };
  // First, and without a model: the recordings need none.
  const sources = wants('sources')
    ? await evaluateSources(cases.sources, deps.sourceFetchers ?? defaultFetcherFactories)
    : [];
  // One thing at a time: a single model is loaded at a time on the eval machine.
  const weekRuns: WeekRun[] = [];
  for (const week of wants('weeks') ? cases.weeks : []) {
    weekRuns.push({ week, run: await replayWeek(week, 1) });
  }
  const stabilityIds: StabilityWeek[] = [];
  for (const { week, run } of weekRuns) {
    const replays = [run];
    for (let i = 1; i < STABILITY_RUNS; i++) replays.push(await replayWeek(week, i + 1));
    stabilityIds.push({ weekId: week.weekId, runs: replays.map(idsOf), replays });
  }
  // The attack replay mixes the attacks into the first recorded week.
  const [firstWeek] = cases.weeks;
  // With the weeks section off, the baseline is replayed here (checkpointed like any week).
  const attackBaseline =
    options.only === 'guards' && firstWeek && cases.attacks.length > 0
      ? await replayWeek(firstWeek, 1)
      : undefined;
  const attack =
    wants('guards') && firstWeek && cases.attacks.length > 0
      ? await replayAttacks(app, deps, firstWeek, cases.attacks)
      : undefined;
  const classifier = wants('classify') ? await classifyCases(app, cases.classifier.cases) : [];
  const grounding = wants('guards')
    ? await checkGrounding(app, cases.grounding)
    : { outcomes: [], tallies: {}, disabledChecks: [] };
  // Last, so the judge model is loaded once, after every replay and every other model call.
  const judged =
    wants('weeks') && deps.judge && app.profile.judge === null
      ? await judgeWinners(
          weekRuns.map(({ run }) => run),
          deps.judge,
          app.logger,
        )
      : undefined;
  return { weekRuns, stabilityIds, attack, attackBaseline, classifier, grounding, judged, sources };
}

/** Runs the whole eval set on one profile and returns its scorecard. Nothing is written. */
export async function runEval(options: EvalOptions, deps: EvalDeps): Promise<SavedScorecard> {
  const startMs = deps.clock.now().getTime();
  const cases = await loadEvalCases(options.casesDir);
  const handle = await deps.buildApp(options.profile);
  try {
    const run = await evaluate(cases, handle.deps, deps, options);
    return buildScorecard({
      profile: options.profile,
      only: options.only,
      cases,
      run,
      app: handle.deps,
      minimums: options.minimums ?? SPEC_EVAL_SET,
      startMs,
      endMs: deps.clock.now().getTime(),
    });
  } finally {
    await handle.close().catch((error: unknown) => {
      handle.deps.logger.warn('Eval could not close the app', { error: errorMessage(error) });
    });
  }
}
