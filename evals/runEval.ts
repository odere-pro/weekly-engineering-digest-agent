// Offline eval: replays the recorded weeks through runDigest, runs the case sets through the
// steps and guards, and returns the scorecard (W1-22). Models, guards and the digest runner are
// injected, so tests use fakes and `digest eval` wires the real ones.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppHandle } from '../src/app/container.js';
import { modelsByRole } from '../src/config/profiles.js';
import { GuardsConfigSchema, type ProfileName } from '../src/config/schema.js';
import type { DigestDeps, RunOptions, RunResult } from '../src/core/runDigest.js';
import {
  ItemSchema,
  SourceKindSchema,
  WEEK_ID_PATTERN,
  type Draft,
  type GuardCheckId,
  type GuardVerdict,
  type Item,
  type RunRecord,
  type Source,
} from '../src/core/schemas.js';
import { classifyStep } from '../src/core/steps/classify.js';
import { guardOutputStep } from '../src/core/steps/guardOutput.js';
import type { InputGuard, OutputGuard } from '../src/ports/Guard.js';
import type { RunStore } from '../src/ports/RunStore.js';
import type { FetchWindow } from '../src/ports/SourceFetcher.js';
import { fixedClock, type Clock } from '../src/shared/clock.js';
import { DigestError, errorMessage } from '../src/shared/errors.js';
import { compareWeekIds, isoWeekId, weekStartUtc } from '../src/shared/isoWeek.js';
import { normalizeUrl, sameUrl } from '../src/shared/url.js';
import {
  assembleMetrics,
  attackHandling,
  attackRunMeasurement,
  classifierAccuracy,
  digestItemIds,
  failedHardGates,
  formatCompliance,
  groundedness,
  guardFalseBlocks,
  linkValidity,
  mustExcludeLeaks,
  mustIncludeRecall,
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
} from './metrics.js';
import {
  AttackCaseSchema,
  ClassifierCasesFileSchema,
  GroundingCaseSchema,
  JudgeCalibrationSchema,
  WeekLabelsSchema,
  type AttackCase,
  type ClassifierCase,
  type GroundingCase,
  type JudgeCalibration,
  type MetricId,
  type Scorecard,
  type WeekLabels,
} from './schema.js';

const DAY_MS = 86_400_000;
/** Recorded weeks are ISO weeks, so each replay collects exactly one week. */
const WEEK_DAYS = 7;
/** Spec: the same week is run 3 times to measure stability. */
const STABILITY_RUNS = 3;
/** Attack items are dated just before the end of the replayed week: newest, so worst case. */
const ATTACK_LEAD_MS = 1000;
/**
 * What the recorder asks every feed for. A replay serves a source this many items unless the
 * allowlist caps the source lower, so it sees all that was recorded.
 */
const RECORDED_ITEMS_PER_SOURCE = 100;
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
export const SPEC_EVAL_SET: EvalSetSize = { weeks: 6, attacks: 10, grounding: 10, classifier: 60 };

export interface EvalOptions {
  profile: ProfileName;
  /** Folder with weeks/, classifier-cases.json, attacks/, grounding/ and judge/. */
  casesDir: string;
  /** A hard gate fails on a smaller set. Default: the spec's set; lower it while cases are written. */
  minimums?: EvalSetSize;
}

export interface EvalDeps {
  /** Builds the app for a profile; runEval closes it when done. */
  buildApp: (profile: ProfileName) => Promise<AppHandle>;
  runDigest: (deps: DigestDeps, options: RunOptions) => Promise<RunResult>;
  /** Wall clock for dates and timings. Replays use their own fixed clock. */
  clock: Clock;
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
  const week = { weekId, items, labels };
  assertLabelsVisible(week, [], weeksDir);
  return week;
}

/** What the replay serves for one source: the allowlist's own cap, else everything recorded. */
function replayCap(sourceId: string, allowlist: readonly Source[]): number {
  return allowlist.find((source) => source.id === sourceId)?.maxItems ?? RECORDED_ITEMS_PER_SOURCE;
}

/** Like the real fetchers: a source's newest items first. */
function newestFirst(items: readonly Item[]): Item[] {
  return items.toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/**
 * A labeled item the replay never serves cannot be recalled or leak, so its label would be
 * silently wrong. Fails when any label sits past the cap of its source (`allowlist` caps; a
 * source it does not list is served in full).
 */
function assertLabelsVisible(week: EvalWeek, allowlist: readonly Source[], weeksDir: string): void {
  const ranks = new Map<string, { sourceId: string; rank: number }>();
  const sourceIds = new Set(week.items.map((item) => item.sourceId));
  for (const sourceId of sourceIds) {
    const own = week.items.filter((item) => item.sourceId === sourceId);
    newestFirst(own).forEach((item, index) => ranks.set(item.id, { sourceId, rank: index + 1 }));
  }
  const labeled = [
    ...week.labels.mustInclude.map((id) => ({ list: 'mustInclude', id })),
    ...week.labels.mustExclude.map((id) => ({ list: 'mustExclude', id })),
  ];
  const unseen = labeled.flatMap(({ list, id }) => {
    const { sourceId = '', rank = 0 } = ranks.get(id) ?? {};
    const cap = replayCap(sourceId, allowlist);
    return rank > cap
      ? [
          `${list} ${id} is item ${rank} of ${sourceId}, but the replay serves only its newest ${cap} items`,
        ]
      : [];
  });
  if (unseen.length > 0) {
    throw new DigestError(`${join(weeksDir, week.weekId, 'labels.json')}: ${unseen.join('; ')}`);
  }
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
      log.push({ itemId: item.id, verdict });
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
 * One source per source id found in the recorded items; the url is never fetched. Each source
 * carries its replay cap, so the pipeline sees what was recorded, not the usual 20 per source.
 */
function sourcesOf(items: readonly Item[], allowlist: readonly Source[]): Source[] {
  const firstOfSource = new Map(items.map((item) => [item.sourceId, item]));
  return [...firstOfSource.values()].map((item) => ({
    id: item.sourceId,
    kind: item.kind,
    url: item.url,
    maxItems: replayCap(item.sourceId, allowlist),
  }));
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

interface Replay {
  weekId: string;
  /** Everything the fetchers served, attack items included. */
  items: readonly Item[];
  markdown: string | undefined;
  record: RunRecord;
  durationMs: number;
  inputVerdicts: InputVerdict[];
}

/** A dry run of runDigest on recorded items: no network, no deliveries, every guard on. */
async function replay(
  app: DigestDeps,
  deps: EvalDeps,
  weekId: string,
  items: readonly Item[],
): Promise<Replay> {
  const inputVerdicts: InputVerdict[] = [];
  const replayDeps: DigestDeps = {
    ...app,
    config: {
      ...app.config,
      sources: sourcesOf(items, app.config.sources),
      topN: REPLAY_TOP_N,
      guards: GuardsConfigSchema.parse({}),
    },
    fetchers: recordedFetchers(items),
    inputGuards: recordInputGuards(app.inputGuards, inputVerdicts),
    deliveries: [],
    store: createEvalStore(),
    clock: fixedClock(endOfWeek(weekId)),
  };
  app.logger.info('Eval replays a week', { weekId, items: items.length });
  const startMs = deps.clock.now().getTime();
  const result = await deps.runDigest(replayDeps, { dryRun: true, weekId, sinceDays: WEEK_DAYS });
  const durationMs = Math.max(0, deps.clock.now().getTime() - startMs);
  return {
    weekId,
    items,
    markdown: result.markdown,
    record: result.record,
    durationMs,
    inputVerdicts,
  };
}

const idsOf = (run: Replay): string[] =>
  run.markdown === undefined ? [] : digestItemIds(run.markdown, run.items);

const sampleOf = (run: Replay): DigestSample => ({
  weekId: run.weekId,
  markdown: run.markdown,
  items: run.items,
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
  const outcomes = attacks.map((attack) => {
    const verdicts = run.inputVerdicts.filter((v) => v.itemId === attack.item.id);
    return {
      caseId: attack.id,
      reachedDigest: reachesDigest(attack.item, run),
      evaluated: verdicts.length > 0,
      blockedBy: flaggedChecks(verdicts.map((v) => v.verdict)),
    };
  });
  return { run, outcomes };
}

async function classifyCases(
  app: DigestDeps,
  cases: readonly ClassifierCase[],
): Promise<ClassifierResult[]> {
  if (cases.length === 0) return [];
  const scored = await classifyStep(
    cases.map((c) => c.item),
    { model: app.model, focusAreas: app.config.focusAreas, logger: app.logger },
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

/** The draft without its planted item: every claim left is supported, so it is a clean control. */
function withoutItem(draft: Draft, itemId: string): Draft | undefined {
  const items = draft.digest.items.filter((item) => item.itemId !== itemId);
  return items.length === 0 ? undefined : { ...draft, digest: { ...draft.digest, items } };
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

interface AttackReplay {
  run: Replay;
  outcomes: AttackOutcome[];
}

interface EvalRun {
  weekRuns: WeekRun[];
  /** Digest item ids of each repeated run of the first week, the first run included. */
  stabilityIds: string[][];
  attack: AttackReplay | undefined;
  classifier: ClassifierResult[];
  grounding: GroundingResults;
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

function measure(scoring: Scoring): Record<MetricId, Measurement> {
  const { cases, run, minimums } = scoring;
  const calibration = calibrationFor(scoring);
  const weekSamples = run.weekRuns.map(({ run: r }) => sampleOf(r));
  const attackSamples = run.attack ? [sampleOf(run.attack.run)] : [];
  const hits = run.weekRuns.map(({ week, run: r }) => ({
    mustInclude: week.labels.mustInclude,
    mustExclude: week.labels.mustExclude,
    digestItemIds: idsOf(r),
  }));
  const inputTallies = tallyOf(
    run.weekRuns.flatMap(({ run: r }) => r.inputVerdicts.map((v) => v.verdict)),
  );
  const records = run.weekRuns.map(({ run: r }) => r.record);
  const classifierCases = cases.classifier.cases.length;
  const unreviewed = classifierCases > 0 && !cases.classifier.reviewed;
  const weeks = (m: Measurement): Measurement =>
    withCoverage(m, cases.weeks.length, minimums.weeks, 'weeks');
  return {
    linkValidity: weeks(linkValidity([...weekSamples, ...attackSamples])),
    attackHandling: withCoverage(
      attackMeasurement(run.attack, run.weekRuns[0]?.run),
      cases.attacks.length,
      minimums.attacks,
      'attack cases',
    ),
    groundedness: withCoverage(
      groundingMeasurement(run.grounding),
      cases.grounding.length,
      minimums.grounding,
      'grounding cases',
    ),
    format: weeks(formatCompliance(weekSamples)),
    guardFalseBlocks: guardFalseBlocks({ ...inputTallies, ...run.grounding.tallies }),
    mustIncludeRecall: weeks(mustIncludeRecall(hits)),
    mustExcludeLeaks: weeks(mustExcludeLeaks(hits)),
    classifierAccuracy: withCoverage(
      {
        ...classifierAccuracy(run.classifier),
        ...(unreviewed ? { note: 'labels not reviewed by the maintainer yet' } : {}),
      },
      classifierCases,
      minimums.classifier,
      'classifier cases',
    ),
    writingQuality: writingQuality(records.flatMap((record) => winnerScore(record) ?? [])),
    // Measured once on the hand-graded digests (W3-04), not on every eval run.
    selectionAgreement: calibration
      ? { value: calibration.selectionAgreement, note: 'from judge/calibration.json' }
      : { value: null },
    writerWinRate: writerWinRate(records.flatMap((record) => record.winner ?? [])),
    stability: stability(run.stabilityIds),
    runTime: runTime(run.weekRuns.map(({ run: r }) => r.durationMs)),
  };
}

function buildScorecard(scoring: Scoring): Scorecard {
  const { profile, cases, run, app, startMs, endMs } = scoring;
  const judgeAgreement = calibrationFor(scoring)?.judgeAgreement ?? null;
  const metrics = assembleMetrics(measure(scoring), judgeAgreement);
  return {
    profile,
    date: new Date(startMs).toISOString(),
    weeks: cases.weeks.map((week) => week.weekId),
    counts: {
      weeks: cases.weeks.length,
      classifier: cases.classifier.cases.length,
      attacks: cases.attacks.length,
      grounding: cases.grounding.length,
    },
    judgeAgreement,
    models: modelsByRole(app.profile),
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    timings: {
      totalMs: Math.max(0, endMs - startMs),
      byWeekMs: Object.fromEntries(
        run.weekRuns.map(({ week, run: r }) => [week.weekId, r.durationMs]),
      ),
    },
  };
}

async function evaluate(cases: EvalCases, app: DigestDeps, deps: EvalDeps): Promise<EvalRun> {
  // One thing at a time: a single model is loaded at a time on the eval machine.
  const weekRuns: WeekRun[] = [];
  for (const week of cases.weeks) {
    weekRuns.push({ week, run: await replay(app, deps, week.weekId, week.items) });
  }
  const first = weekRuns[0];
  const stabilityIds: string[][] = first ? [idsOf(first.run)] : [];
  for (let i = 1; first && i < STABILITY_RUNS; i++) {
    stabilityIds.push(idsOf(await replay(app, deps, first.week.weekId, first.week.items)));
  }
  const attack =
    first && cases.attacks.length > 0
      ? await replayAttacks(app, deps, first.week, cases.attacks)
      : undefined;
  return {
    weekRuns,
    stabilityIds,
    attack,
    classifier: await classifyCases(app, cases.classifier.cases),
    grounding: await checkGrounding(app, cases.grounding),
  };
}

/** Runs the whole eval set on one profile and returns its scorecard. Nothing is written. */
export async function runEval(options: EvalOptions, deps: EvalDeps): Promise<Scorecard> {
  const startMs = deps.clock.now().getTime();
  const cases = await loadEvalCases(options.casesDir);
  const handle = await deps.buildApp(options.profile);
  try {
    const weeksDir = join(options.casesDir, 'weeks');
    for (const week of cases.weeks) assertLabelsVisible(week, handle.deps.config.sources, weeksDir);
    const run = await evaluate(cases, handle.deps, deps);
    return buildScorecard({
      profile: options.profile,
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
