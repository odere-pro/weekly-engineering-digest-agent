// `digest eval`: replays the eval set per profile, prints each scorecard, saves it and returns the
// exit code. This file orders the work; scorecardText/, judgeSetup/ and compare/ do the parts (see
// CLAUDE.md). The harness itself is evals/runEval.ts.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkpointDir, fingerprintOf } from '../../../evals/checkpoint';
import {
  EVAL_SECTIONS,
  SavedScorecardSchema,
  parseSection,
  type EvalSection,
  type SavedScorecard,
} from '../../../evals/checkpointSections';
import { failedHardGates } from '../../../evals/metrics';
import { runEval, type EvalDeps, type EvalOptions } from '../../../evals/runEval';
import {
  buildApp,
  createAppLogger,
  createModelProvider,
  type AppHandle,
} from '../../app/container';
import { loadConfig, platformOf, type LoadedConfig } from '../../config/load';
import { resolveProfile, type Platform } from '../../config/profiles';
import { ProfileNameSchema, type ProfileName } from '../../config/schema';
import { runDigest } from '../../digest/runDigest';
import type { ModelProvider } from '../../models/ModelProvider';
import { systemClock, type Clock } from '../../shared/clock';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { printComparison } from './compare/printComparison';
import { prepareEvalJudge } from './judgeSetup/prepareEvalJudge';
import { formatScorecard } from './scorecardText/formatScorecard';

export interface EvalCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Profile name, or "all". Defaults to the configured profile. */
  profile?: string;
  /** Run one section only: guards, classify, sources or weeks. Saves a partial scorecard. */
  only?: string;
  /** Reuse the week replays a lost run already saved, when the config and git sha are the same. */
  resume?: boolean;
  /** Two saved scorecards to compare; nothing is run. */
  compare?: string[];
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
  runEval: (options: EvalOptions, deps: EvalDeps) => Promise<SavedScorecard>;
  /** The git commit the code is at; part of what a checkpoint is valid for. */
  gitSha: () => Promise<string>;
  /** The folder this run's checkpoints use; the newest date folder when resuming. */
  checkpointDir: (root: string, today: string, resume: boolean) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  clock: Clock;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const ALL_PROFILES = 'all';
const EXIT_OK = 0;
const EXIT_HARD_GATE_FAILED = 1;
const CHECKPOINT_ROOT = ['eval', 'checkpoints'] as const;
const DATE_CHARS = 10;
const GIT_SHA_UNKNOWN = 'unknown';
const DIFF_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The checkout's commit plus a hash of its uncommitted changes, so editing a prompt and resuming
 * does not reuse old replays. Outside a git checkout the value is new every time: no resume.
 */
async function currentGitSha(): Promise<string> {
  const git = promisify(execFile);
  try {
    const head = (await git('git', ['rev-parse', 'HEAD'])).stdout.trim();
    const status = (await git('git', ['status', '--porcelain'])).stdout;
    const diff =
      status === ''
        ? ''
        : (await git('git', ['diff', 'HEAD'], { maxBuffer: DIFF_MAX_BYTES })).stdout;
    return status === '' ? head : `${head}+${fingerprintOf({ status, diff })}`;
  } catch {
    return `${GIT_SHA_UNKNOWN}-${Date.now()}`;
  }
}

const defaultIo: EvalCommandIo = {
  casesDir: 'evals',
  // The same logger the app builds for a run: stdout and the day's log file, secrets taken out.
  createEvalLogger: createAppLogger,
  createProvider: createModelProvider,
  loadConfig: (options) => loadConfig(options),
  buildApp,
  runDigest,
  runEval,
  gitSha: currentGitSha,
  checkpointDir,
  readFile: (path) => readFile(path, 'utf8'),
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

function requestedSection(only: string | undefined): EvalSection | undefined {
  if (only === undefined) return undefined;
  const section = parseSection(only);
  if (section === undefined) {
    throw new DigestError(`Unknown section "${only}". Use ${EVAL_SECTIONS.join(', ')}.`);
  }
  return section;
}

async function runProfiles(options: EvalCommandOptions, io: EvalCommandIo): Promise<number> {
  if (options.compare !== undefined) {
    await printComparison(options.compare, io);
    return EXIT_OK;
  }
  const only = requestedSection(options.only);
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
  const resume = options.resume === true;
  const checkpoints = {
    dir: await io.checkpointDir(
      join(loaded.config.dataDir, ...CHECKPOINT_ROOT),
      io.clock.now().toISOString().slice(0, DATE_CHARS),
      resume,
    ),
    resume,
    gitSha: await io.gitSha(),
  };
  const scorecards: SavedScorecard[] = [];
  for (const profile of profiles) {
    const scorecard = await io.runEval(
      { profile, casesDir: io.casesDir, checkpoints, ...(only ? { only } : {}) },
      deps,
    );
    // Print first: a failed save must not lose the result of a long run.
    io.stdout(`${formatScorecard(scorecard)}\n`);
    await saveScorecard(io, scorecard);
    scorecards.push(scorecard);
  }
  // A partial run reports its gates but never fails the command: the other sections were not run.
  const passed = scorecards.every(
    (s) => s.partial !== undefined || failedHardGates(s.metrics).length === 0,
  );
  return passed ? EXIT_OK : EXIT_HARD_GATE_FAILED;
}

async function saveScorecard(io: EvalCommandIo, scorecard: SavedScorecard): Promise<void> {
  const dir = join(io.casesDir, 'scorecards');
  await io.mkdir(dir);
  // A partial scorecard gets its own name, so it never replaces the full one of the same day.
  const suffix = scorecard.partial ? `-partial-${scorecard.partial.join('-')}` : '';
  const path = join(dir, `${scorecard.date.slice(0, 10)}-${scorecard.profile}${suffix}.json`);
  await io.writeFile(path, `${JSON.stringify(SavedScorecardSchema.parse(scorecard), null, 2)}\n`);
}
