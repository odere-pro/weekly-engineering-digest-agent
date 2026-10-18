import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertJudgeInstalled,
  createEvalJudge,
  evalJudgeTag,
  type EvalJudge,
} from '../../../evals/judge/evalJudge';
import { failedHardGates } from '../../../evals/metrics';
import { runEval, type EvalDeps, type EvalOptions } from '../../../evals/runEval';
import {
  METRIC_IDS,
  ScorecardSchema,
  type MetricResult,
  type Scorecard,
  type WeekDetail,
} from '../../../evals/schema';
import { buildApp, createModelProvider, type AppHandle } from '../../app/container';
import { knownSecrets } from '../../app/redacting';
import { loadConfig, platformOf, type LoadedConfig } from '../../config/load';
import { resolveProfile, type Platform } from '../../config/profiles';
import { ProfileNameSchema, type ProfileName } from '../../config/schema';
import { runDigest } from '../../digest/runDigest';
import { createLogger } from '../../observability/logger';
import type { ModelProvider } from '../../models/ModelProvider';
import { systemClock, type Clock } from '../../shared/clock';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { truncate } from '../../shared/text';

export interface EvalCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Profile name, or "all". Defaults to the configured profile. */
  profile?: string;
}

/** Everything the command touches outside itself; tests replace it, `digest eval` uses the defaults. */
export interface EvalCommandIo {
  /** Folder with the recorded weeks and cases; scorecards go to <casesDir>/scorecards. */
  casesDir: string;
  /** The logger the eval judge's provider writes to, so its retry and timeout warnings show. */
  createEvalLogger: (loaded: LoadedConfig) => Logger;
  /** Builds the eval judge's model provider: the container's one place for model providers. */
  createProvider: (loaded: LoadedConfig, extras: { logger: Logger }) => ModelProvider;
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  buildApp: (loaded: LoadedConfig) => Promise<AppHandle>;
  runDigest: EvalDeps['runDigest'];
  runEval: (options: EvalOptions, deps: EvalDeps) => Promise<Scorecard>;
  clock: Clock;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const ALL_PROFILES = 'all';
const EXIT_OK = 0;
const EXIT_HARD_GATE_FAILED = 1;
const DETAIL_DECIMALS = 3;
/** Printing keeps a scorecard to a screen; the JSON file has every problem and every id in full. */
const MAX_PROBLEMS_SHOWN = 3;
const MAX_PRINTED_PROBLEM_CHARS = 120;
const SHORT_ID_CHARS = 8;
/** The id evals/metrics.ts gives a digest link that matches no collected item: `unmatched:<url>`. */
const UNMATCHED_ID_PREFIX = 'unmatched:';
const UNMATCHED_ID_TEXT = 'unmatched';
/**
 * Text a model wrote must not move the cursor, recolor the terminal or reorder what is read:
 * control characters (incl. escapes, newlines, C1), line and paragraph separators, zero-width
 * and bidirectional marks, and tag characters.
 */
const UNSAFE_TEXT =
  /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]+/gu;

const defaultIo: EvalCommandIo = {
  casesDir: 'evals',
  // The same logger the app builds for a run: JSON on stdout at LOG_LEVEL, secrets taken out.
  createEvalLogger: ({ env, secrets }) =>
    createLogger({ level: env.LOG_LEVEL, redactValues: knownSecrets(secrets) }),
  createProvider: createModelProvider,
  loadConfig: (options) => loadConfig(options),
  buildApp,
  runDigest,
  runEval,
  clock: systemClock,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** `digest eval`: Runs the eval set and prints the scorecard (W1-22). Returns the process exit code. */
export async function evalCommand(
  options: EvalCommandOptions,
  overrides: Partial<EvalCommandIo> = {},
): Promise<number> {
  const io: EvalCommandIo = { ...defaultIo, ...overrides };
  try {
    return await runProfiles(options, io);
  } catch (error) {
    if (!(error instanceof DigestError)) throw error;
    io.stderr(`${error.message}\n`);
    return error.exitCode;
  }
}

/** undefined means "the configured profile". */
function requestedProfiles(requested: string | undefined): ProfileName[] | undefined {
  if (requested === undefined) return undefined;
  if (requested === ALL_PROFILES) return [...ProfileNameSchema.options];
  const parsed = ProfileNameSchema.safeParse(requested);
  if (!parsed.success) {
    const known = ProfileNameSchema.options.join(', ');
    throw new DigestError(`Unknown profile "${requested}". Use ${known} or ${ALL_PROFILES}.`);
  }
  return [parsed.data];
}

/** The loaded config, switched to another profile (writers overrides in config still apply). */
function withProfile(loaded: LoadedConfig, name: ProfileName, platform: Platform): LoadedConfig {
  return {
    ...loaded,
    config: { ...loaded.config, profile: name },
    profile: resolveProfile(name, platform, loaded.config.models.writers),
  };
}

/**
 * The judge that scores the winning digest on a profile without one of its own, when EVAL_JUDGE
 * (from the loaded environment: `.env` or the shell) names a model; undefined otherwise, and the
 * harness then leaves writing quality unmeasured. A tag Ollama cannot serve fails here, before
 * the replay starts.
 */
async function prepareEvalJudge(
  loaded: LoadedConfig,
  io: EvalCommandIo,
): Promise<EvalJudge | undefined> {
  const model = evalJudgeTag(loaded.env);
  if (model === undefined) return undefined;
  // The judge role resolves through the profile, and light and fast have no judge of their own.
  const judging: LoadedConfig = { ...loaded, profile: { ...loaded.profile, judge: model } };
  const provider = io.createProvider(judging, { logger: io.createEvalLogger(loaded) });
  await assertJudgeInstalled(provider, model);
  return createEvalJudge({ provider, model, focusAreas: loaded.config.focusAreas });
}

async function runProfiles(options: EvalCommandOptions, io: EvalCommandIo): Promise<number> {
  const requested = requestedProfiles(options.profile);
  const loaded = await io.loadConfig({ configPath: options.config });
  const profiles = requested ?? [loaded.config.profile];
  // The same host the loader used for the configured profile, so a container on a Mac matches it.
  const platform = platformOf(loaded);
  const judge = await prepareEvalJudge(loaded, io);
  const deps: EvalDeps = {
    buildApp: (profile) => io.buildApp(withProfile(loaded, profile, platform)),
    runDigest: io.runDigest,
    clock: io.clock,
    ...(judge ? { judge } : {}),
  };
  const scorecards: Scorecard[] = [];
  for (const profile of profiles) {
    const scorecard = await io.runEval({ profile, casesDir: io.casesDir }, deps);
    // Print first: a failed save must not lose the result of a long run.
    io.stdout(`${formatScorecard(scorecard)}\n`);
    await saveScorecard(io, scorecard);
    scorecards.push(scorecard);
  }
  const passed = scorecards.every((s) => failedHardGates(s.metrics).length === 0);
  return passed ? EXIT_OK : EXIT_HARD_GATE_FAILED;
}

async function saveScorecard(io: EvalCommandIo, scorecard: Scorecard): Promise<void> {
  const dir = join(io.casesDir, 'scorecards');
  await io.mkdir(dir);
  const path = join(dir, `${scorecard.date.slice(0, 10)}-${scorecard.profile}.json`);
  await io.writeFile(path, `${JSON.stringify(ScorecardSchema.parse(scorecard), null, 2)}\n`);
}

// --- Printing -------------------------------------------------------------------------------

function valueCell(metric: MetricResult): string {
  if (metric.value === null) return 'n/a';
  switch (metric.unit) {
    case 'ratio':
      return `${(metric.value * 100).toFixed(1)}%`;
    case 'ms':
      return `${(metric.value / 1000).toFixed(1)} s`;
    default:
      return metric.value.toFixed(2);
  }
}

function gateCell(metric: MetricResult): string {
  const { gate } = metric;
  if (gate.kind === 'none') return 'reported';
  const threshold =
    metric.unit === 'ratio' ? `${Math.round(gate.threshold * 100)}%` : String(gate.threshold);
  const symbol = gate.direction === 'atLeast' ? '≥' : '≤';
  return `${gate.kind} ${symbol} ${threshold}${gate.needsJudge ? ' (judge)' : ''}`;
}

function resultCell(metric: MetricResult): string {
  if (metric.pass === null) return '-';
  return metric.pass ? 'PASS' : 'FAIL';
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = (rows[0] ?? []).map((_, col) =>
    Math.max(...rows.map((row) => row[col]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}

function detailText(detail: Readonly<Record<string, number>>): string {
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${Number(value.toFixed(DETAIL_DECIMALS))}`)
    .join(', ');
}

/** Model-written text as one printable line: unsafe characters become a space; cut when long. */
function safeText(text: string): string {
  return text.replace(UNSAFE_TEXT, ' ').trim();
}

function oneLine(text: string): string {
  return truncate(safeText(text), MAX_PRINTED_PROBLEM_CHARS);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function weekStatus({ status, problemCount }: WeekDetail): string {
  if (status === 'no-digest') return 'no digest';
  return problemCount > 0 ? `${status}, ${plural(problemCount, 'problem')}` : status;
}

/** What the first problems leave out: the file keeps up to `stored` of `total`, no more. */
function moreLines(detail: WeekDetail, shownCount: number): string[] {
  const stored = detail.problems.length;
  const total = Math.max(detail.problemCount, stored);
  const more = total - shownCount;
  if (more <= 0) return [];
  return [
    stored < total
      ? `    ... ${more} more (the scorecard file lists the first ${stored} of ${total})`
      : `    ... ${more} more in the scorecard file`,
  ];
}

/** One week that did not pass: its status, then the first few problems. */
function weekLines(metric: MetricResult, label: string, detail: WeekDetail): string[] {
  const shown = detail.problems.slice(0, MAX_PROBLEMS_SHOWN);
  return [
    `  ${metric.label} ${label}: ${weekStatus(detail)}`,
    ...shown.map((problem) => `    - ${oneLine(problem)}`),
    ...moreLines(detail, shown.length),
  ];
}

/** Format and link validity: the weeks that failed or produced nothing; weeks that passed are left out. */
function weekProblemLines(metrics: readonly MetricResult[]): string[] {
  return metrics.flatMap((metric) =>
    Object.entries(metric.byWeek ?? {})
      .filter(([, detail]) => detail.status !== 'ok')
      .flatMap(([label, detail]) => weekLines(metric, label, detail)),
  );
}

/** A link that matched no item carries the URL the model wrote; show that it was invented, not it. */
function shortId(id: string): string {
  if (id.startsWith(UNMATCHED_ID_PREFIX)) return UNMATCHED_ID_TEXT;
  return Array.from(safeText(id)).slice(0, SHORT_ID_CHARS).join('');
}

function runText(ids: readonly string[]): string {
  if (ids.length === 0) return 'no items';
  const shortIds = ids.map(shortId).join(' ');
  return `${plural(ids.length, 'item')}: ${shortIds}`;
}

/** Stability: what each run picked, so empty digests and different picks can be told apart. */
function itemIdsByRunLines(metrics: readonly MetricResult[]): string[] {
  return metrics.flatMap((metric) =>
    (metric.itemIdsByRun ?? []).map(
      (ids, run) => `  ${metric.label} run ${run + 1}: ${runText(ids)}`,
    ),
  );
}

/** A titled block after a blank line; nothing when there are no lines. */
function section(title: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? ['', title, ...lines] : [];
}

/** The scorecard as plain text: header, metric table, details, problems, notes and the verdict. */
export function formatScorecard(scorecard: Scorecard): string {
  const metrics = METRIC_IDS.map((id) => scorecard.metrics[id]);
  const { counts } = scorecard;
  const judge =
    scorecard.judgeAgreement === null
      ? 'not calibrated'
      : `${Math.round(scorecard.judgeAgreement * 100)}%`;
  const failed = failedHardGates(scorecard.metrics);
  const details = metrics.flatMap((m) =>
    m.detail ? [`  ${m.label}: ${detailText(m.detail)}`] : [],
  );
  const notes = metrics.flatMap((m) => (m.note ? [`  ${m.label}: ${m.note}`] : []));
  return [
    `Eval scorecard: ${scorecard.profile} (${scorecard.date.slice(0, 10)})`,
    `Cases: ${counts.weeks} weeks, ${counts.classifier} classifier, ${counts.attacks} attacks, ${counts.grounding} grounding`,
    `Judge agreement: ${judge}`,
    '',
    ...table([
      ['Metric', 'Value', 'Gate', 'Result'],
      ...metrics.map((m) => [m.label, valueCell(m), gateCell(m), resultCell(m)]),
    ]),
    ...section('Details:', details),
    ...section('Week problems:', weekProblemLines(metrics)),
    ...section(
      `Item ids by run (first ${SHORT_ID_CHARS} characters; the scorecard file has them in full):`,
      itemIdsByRunLines(metrics),
    ),
    ...section('Notes:', notes),
    '',
    failed.length === 0 ? 'Hard gates: PASS' : `Hard gates: FAIL (${failed.join(', ')})`,
  ].join('\n');
}
