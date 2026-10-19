import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  digestFilePaths,
  markdownFileOptions,
  markdownFolder,
} from '../../delivery/adapters/markdownFile';
import { DIGEST_FILE } from '../../store/adapters/runFolders';
import { weekDigestDir } from '../../store/layout';
import { buildApp, type AppHandle } from '../../app/container';
import { loadConfig, redactSecrets, type LoadedConfig } from '../../config/load';
import type { Secrets } from '../../config/schema';
import { runDigest } from '../../digest/runDigest';
import { type DigestDeps, type RunOptions, type RunResult } from '../../digest/types';
import { ExitCode } from '../../domain/schemas';
import { DigestError, errorMessage } from '../../shared/errors';
import { formatRunDuration } from '../history/history';

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
}

/** Everything the command touches outside itself; tests replace it, `digest run` uses the defaults. */
export interface RunCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  buildApp: (loaded: LoadedConfig) => Promise<AppHandle>;
  runDigest: (deps: DigestDeps, options: RunOptions) => Promise<RunResult>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SINCE_PATTERN = /^(\d+)d$/;
const MIN_SINCE_DAYS = 1;
const MAX_SINCE_DAYS = 31;
const LABEL_WIDTH = 'Duration'.length;

/** The command's output channels; everything printed passes through the secret redaction. */
interface Reporter {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** The digest files in the local folder, as the summary lists them. */
interface LocalFiles {
  markdown: string;
  /** Set only when the HTML copy is there. */
  html?: string;
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
};

/** `digest run`: One full run; --dry-run writes the digest to disk and sends nothing (W1-17). Returns the process exit code. */
export async function runCommand(
  options: RunCommandOptions,
  deps: Partial<RunCommandDeps> = {},
): Promise<number> {
  const io: RunCommandDeps = { ...defaultDeps, ...deps };
  let secrets: Secrets = {};
  const report: Reporter = {
    out: (text) => {
      io.stdout(redactSecrets(text, secrets));
    },
    err: (text) => {
      io.stderr(redactSecrets(text, secrets));
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
    secrets = loaded.secrets;
    const app = await io.buildApp(loaded);
    try {
      const result = await io.runDigest(app.deps, {
        sinceDays,
        dryRun: options.dryRun,
        force: options.force,
      });
      const copy = await saveDryRunCopy(app, result);
      const dir = markdownFolder(markdownFileOptions(loaded.config), result.record.runId);
      printSummary(report, loaded, result, await localFilesOf(dir, result, copy.written));
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

/** The seed is a whole number of 0 or more; commander checks it too, library callers may not. */
function parseSeed(seed: number | undefined): number | undefined {
  if (seed === undefined) return undefined;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new DigestError(`Invalid --seed "${seed}". Use a whole number of 0 or more.`);
  }
  return seed;
}

/** A new LoadedConfig whose models.seed is `seed`; the loaded one stays as it was. */
function withSeed(loaded: LoadedConfig, seed: number | undefined): LoadedConfig {
  if (seed === undefined) return loaded;
  return {
    ...loaded,
    config: { ...loaded.config, models: { ...loaded.config.models, seed } },
  };
}

/** The folder for the digest files, as given. Blank is refused: the schema needs a real path. */
function parseOut(out: string | undefined): string | undefined {
  if (out === undefined) return undefined;
  if (out.trim() === '') {
    throw new DigestError(
      `Invalid --out "${out}". Give the folder for the digest files, for example --out ./digests.`,
    );
  }
  return out;
}

/** A new LoadedConfig whose Markdown folder is `dir`; the loaded one stays as it was. */
function withOut(loaded: LoadedConfig, dir: string | undefined): LoadedConfig {
  if (dir === undefined) return loaded;
  const { delivery } = loaded.config;
  return {
    ...loaded,
    config: {
      ...loaded.config,
      delivery: { ...delivery, markdown: { ...delivery.markdown, dir } },
    },
  };
}

/** "7d" is 7 days. Undefined means "use the configured window". */
function parseSince(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const days = Number(SINCE_PATTERN.exec(since)?.[1]);
  if (!Number.isInteger(days) || days < MIN_SINCE_DAYS || days > MAX_SINCE_DAYS) {
    throw new DigestError(
      `Invalid --since "${since}". Use a number of days from ${MIN_SINCE_DAYS}d to ${MAX_SINCE_DAYS}d, for example 7d.`,
    );
  }
  return days;
}

/** What `saveDryRunCopy` did: `error` is set when the write failed. */
interface DryRunCopy {
  written: boolean;
  error?: string;
}

/**
 * A dry run skips delivery, yet its digest still goes to the local folder: a file is not a send.
 * Only the Markdown channel is used, so email and Slack get nothing. A run that kept the week's
 * earlier files has no markdown and writes nothing here either. Never throws.
 */
async function saveDryRunCopy(app: AppHandle, result: RunResult): Promise<DryRunCopy> {
  const { record, markdown, message } = result;
  if (record.status !== 'dry-run' || markdown === undefined) return { written: false };
  const channel = app.deps.deliveries.find((delivery) => delivery.id === 'markdown');
  if (!channel) return { written: false };
  try {
    await channel.sendDigest(
      message ?? { weekId: record.runId, subject: `Engineering digest ${record.runId}`, markdown },
    );
    return { written: true };
  } catch (error) {
    return { written: false, error: errorMessage(error) };
  }
}

/**
 * The local files of a run whose Markdown channel took the digest, or of a dry run that was
 * just written. The HTML copy is listed only when it is there: not every digest has a view.
 */
async function localFilesOf(
  dir: string,
  result: RunResult,
  wroteDryRunCopy: boolean,
): Promise<LocalFiles | undefined> {
  const { record } = result;
  const reached = wroteDryRunCopy || record.deliveredTo?.includes('markdown') === true;
  if (!reached) return undefined;
  const paths = digestFilePaths(dir, record.runId);
  const [hasMarkdown, hasHtml] = await Promise.all([
    fileExists(paths.markdown),
    fileExists(paths.html),
  ]);
  // A resumed week whose Markdown channel took the digest in an earlier run (and maybe another
  // folder) has nothing here: list what is there, not what the folder should hold.
  if (!hasMarkdown) return undefined;
  return hasHtml ? paths : { markdown: paths.markdown };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

function printSummary(
  report: Reporter,
  loaded: LoadedConfig,
  result: RunResult,
  files: LocalFiles | undefined,
): void {
  const { record } = result;
  const fields: [string, string][] = [
    ['Week', record.runId],
    ['Status', record.status],
    ['Items', `${record.counts.collected} collected → ${record.counts.digestItems} in digest`],
    ['Winner', record.winner ?? '-'],
    ['Duration', formatRunDuration(record)],
  ];
  if (result.markdown !== undefined) {
    fields.push(['Digest', join(weekDigestDir(loaded.config.dataDir, record.runId), DIGEST_FILE)]);
  }
  if (files) {
    fields.push(['Markdown', files.markdown]);
    if (files.html !== undefined) fields.push(['HTML', files.html]);
  }
  const lines = fields.map(([label, value]) => `${label.padEnd(LABEL_WIDTH)}  ${value}`);
  for (const source of record.failedSources) {
    lines.push(`Failed source: ${source.sourceId} (${source.error})`);
  }
  for (const draft of record.drafts) {
    if (!draft.passed)
      lines.push(`Rejected draft: ${draft.writer} (${draft.rejectedBy.join(', ')})`);
  }
  const note = statusNote(record.status);
  if (note) lines.push(note);
  if (result.kept !== undefined) lines.push(keptNote(result.kept));
  report.out(`${lines.join('\n')}\n`);
  if (record.error) {
    const step = record.error.step ? ` (step: ${record.error.step})` : '';
    report.err(`Error${step}: ${record.error.message}\n`);
  }
}

/** The reason is in the log too; here it stands in for the Digest line a kept week does not get. */
function keptNote(reason: string): string {
  return `${reason}. The week's run folder is unchanged.`;
}

function statusNote(status: RunResult['record']['status']): string | undefined {
  switch (status) {
    case 'dry-run':
      return 'Dry run: nothing was sent.';
    case 'skipped':
      return 'This week already has a sent digest. Use --force to run it again.';
    default:
      return undefined;
  }
}
