import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { failedHardGates } from '../../evals/metrics.js';
import { runEval, type EvalDeps, type EvalOptions } from '../../evals/runEval.js';
import {
  METRIC_IDS,
  ScorecardSchema,
  type MetricResult,
  type Scorecard,
} from '../../evals/schema.js';
import { buildApp, type AppHandle } from '../app/container.js';
import { loadConfig, platformOf, type LoadedConfig } from '../config/load.js';
import { resolveProfile, type Platform } from '../config/profiles.js';
import { ProfileNameSchema, type ProfileName } from '../config/schema.js';
import { runDigest } from '../core/runDigest.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { DigestError } from '../shared/errors.js';

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

const defaultIo: EvalCommandIo = {
  casesDir: 'evals',
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

async function runProfiles(options: EvalCommandOptions, io: EvalCommandIo): Promise<number> {
  const requested = requestedProfiles(options.profile);
  const loaded = await io.loadConfig({ configPath: options.config });
  const profiles = requested ?? [loaded.config.profile];
  // The same host the loader used for the configured profile, so a container on a Mac matches it.
  const platform = platformOf(loaded);
  const deps: EvalDeps = {
    buildApp: (profile) => io.buildApp(withProfile(loaded, profile, platform)),
    runDigest: io.runDigest,
    clock: io.clock,
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

/** The scorecard as plain text: header, metric table, details, notes and the hard-gate verdict. */
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
    ...(details.length > 0 ? ['', 'Details:', ...details] : []),
    ...(notes.length > 0 ? ['', 'Notes:', ...notes] : []),
    '',
    failed.length === 0 ? 'Hard gates: PASS' : `Hard gates: FAIL (${failed.join(', ')})`,
  ].join('\n');
}
