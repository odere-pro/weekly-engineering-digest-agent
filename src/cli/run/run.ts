import { buildApp, type AppHandle } from '../../app/container';
import { knownSecrets } from '../../app/redaction/knownSecrets';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { runDigest } from '../../digest/runDigest';
import { type DigestDeps, type RunOptions, type RunResult } from '../../digest/types';
import { ExitCode } from '../../domain/schemas';
import { createRedactor, type Redactor } from '../../observability/redact';
import { DigestError, errorMessage } from '../../shared/errors';
import { systemClock, type Clock } from '../../shared/clock';
import { readTextIfExists, writeFileAtomic } from '../../shared/atomicFile';
import { createFsRunStore } from '../../store/adapters/fsRunStore';
import type { RunStore } from '../../store/RunStore';
import { parseSince } from '../fetch/plan/parseSince';
import { inquirerPrompts } from '../init/io/inquirerPrompts';
import { prepareAgain } from './again/prepare';
import { runAgain } from './again/runAgain';
import type { RunPrompts } from './again/types';
import { parseOut, parseSeed, withOut, withSeed } from './flags/flags';
import { saveLocalCopy, type LocalCopy } from './summary/localCopy';
import { reportRun } from './summary/report';
import type { Reporter } from './summary/summary';

export interface RunCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Collection window, e.g. "7d"; defaults to config.windowDays. */
  since?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Sampling seed for this run; overrides `models.seed`. */
  seed?: number;
  /** Folder for the digest files; overrides `delivery.markdown.dir` for this run. */
  out?: string;
  /** Second run of a week: fetch every source again and merge with the saved items. */
  enrich?: boolean;
  /** Second run of a week: the normal digest plus every item that passed the filters. */
  complete?: boolean;
  /** Second run of a week: favour this topic in the relevance question and the writer prompt. */
  perspective?: string;
  /** Second run of a week: fetch only these new source URLs and merge with the saved items. */
  addSource?: string[];
}

/** Everything the command touches outside itself; tests replace it, `digest run` uses the defaults. */
export interface RunCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  buildApp: (loaded: LoadedConfig) => Promise<AppHandle>;
  runDigest: (deps: DigestDeps, options: RunOptions) => Promise<RunResult>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The questions of a second run. */
  prompts: RunPrompts;
  /** True when a person can answer: stdin and stdout are terminals. */
  interactive: boolean;
  /** Opens the run history, to find the week's earlier run before the app is built. */
  createStore: (dataDir: string) => RunStore;
  clock: Clock;
  readFile: (path: string) => Promise<string | undefined>;
  writeFile: (path: string, content: string) => Promise<void>;
}

const defaultDeps: RunCommandDeps = {
  loadConfig: (options) => loadConfig(options),
  buildApp,
  runDigest,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  prompts: inquirerPrompts,
  get interactive() {
    return process.stdin.isTTY && process.stdout.isTTY;
  },
  createStore: (dataDir) => createFsRunStore({ dataDir }),
  clock: systemClock,
  readFile: readTextIfExists,
  writeFile: writeFileAtomic,
};

/** `digest run`: One full run; --dry-run writes the digest to disk and sends nothing (W1-17). Returns the process exit code. */
export async function runCommand(
  options: RunCommandOptions,
  deps: Partial<RunCommandDeps> = {},
): Promise<number> {
  const io: RunCommandDeps = { ...defaultDeps, ...deps };
  // Until the config loads there is nothing to hide; then the secrets and the OLLAMA_URL password.
  let redactor: Redactor = createRedactor();
  const report: Reporter = {
    out: (text) => {
      io.stdout(redactor.text(text));
    },
    err: (text) => {
      io.stderr(redactor.text(text));
    },
  };
  try {
    const sinceDays = parseSince(options.since);
    const seed = parseSeed(options.seed);
    const out = parseOut(options.out);
    const loaded = withOut(
      withSeed(await io.loadConfig({ configPath: options.config }), seed),
      out,
    );
    redactor = createRedactor(knownSecrets(loaded.secrets, loaded.env.OLLAMA_URL));
    const again = await prepareAgain(options, loaded, io, report);
    const app = await io.buildApp(again?.loaded ?? loaded);
    try {
      if (again) {
        const { reuse, variant } = again;
        return await runAgain(
          app,
          { ...io, report },
          { loaded: again.loaded, reuse, variant, sinceDays, dryRun: options.dryRun },
        );
      }
      const result = await io.runDigest(app.deps, {
        sinceDays,
        dryRun: options.dryRun,
        force: options.force,
      });
      const copy = await dryRunCopy(app, result);
      const dir = await reportRun(report, loaded, result, copy);
      if (copy.error === undefined) return result.exitCode;
      report.err(`Error: could not write the dry-run digest to ${dir}: ${copy.error}\n`);
      return ExitCode.Failed;
    } finally {
      await closeApp(app, report);
    }
  } catch (error) {
    report.err(`${errorMessage(error)}\n`);
    return error instanceof DigestError ? error.exitCode : ExitCode.Failed;
  }
}

/** A failed close is reported, but never hides the run's outcome or its error. */
async function closeApp(app: AppHandle, report: Reporter): Promise<void> {
  try {
    await app.close();
  } catch (error) {
    report.err(`Warning: could not close the app cleanly: ${errorMessage(error)}\n`);
  }
}

/**
 * A dry run skips delivery, yet its digest still goes to the local folder. A run that kept the
 * week's earlier files has no markdown and writes nothing here either.
 */
async function dryRunCopy(app: AppHandle, result: RunResult): Promise<LocalCopy> {
  const { record, markdown, message } = result;
  if (record.status !== 'dry-run' || markdown === undefined) return { written: false };
  return saveLocalCopy(
    app,
    message ?? { weekId: record.runId, subject: `Engineering digest ${record.runId}`, markdown },
  );
}
