import { join } from 'node:path';
import { DIGEST_FILE } from '../adapters/store/runFolders.js';
import { buildApp, type AppHandle } from '../app/container.js';
import { loadConfig, redactSecrets, type LoadedConfig } from '../config/load.js';
import type { Secrets } from '../config/schema.js';
import { runDigest, type DigestDeps, type RunOptions, type RunResult } from '../core/runDigest.js';
import { ExitCode } from '../core/schemas.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import { formatRunDuration } from './history.js';

export interface RunCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Collection window, e.g. "7d"; defaults to config.windowDays. */
  since?: string;
  dryRun?: boolean;
  force?: boolean;
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
    const loaded = await io.loadConfig({ configPath: options.config });
    secrets = loaded.secrets;
    const app = await io.buildApp(loaded);
    try {
      const result = await io.runDigest(app.deps, {
        sinceDays,
        dryRun: options.dryRun,
        force: options.force,
      });
      printSummary(report, loaded, result);
      return result.exitCode;
    } finally {
      await closeApp(app, report);
    }
  } catch (error) {
    report.err(`${errorMessage(error)}\n`);
    return error instanceof DigestError ? error.exitCode : ExitCode.Failed;
  }
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

/** A failed close is reported, but never hides the run's outcome or its error. */
async function closeApp(app: AppHandle, report: Reporter): Promise<void> {
  try {
    await app.close();
  } catch (error) {
    report.err(`Warning: could not close the app cleanly: ${errorMessage(error)}\n`);
  }
}

function printSummary(report: Reporter, loaded: LoadedConfig, result: RunResult): void {
  const { record } = result;
  const fields: [string, string][] = [
    ['Week', record.runId],
    ['Status', record.status],
    ['Items', `${record.counts.collected} collected → ${record.counts.digestItems} in digest`],
    ['Winner', record.winner ?? '-'],
    ['Duration', formatRunDuration(record)],
  ];
  if (result.markdown !== undefined) {
    fields.push(['Digest', join(loaded.config.dataDir, 'runs', record.runId, DIGEST_FILE)]);
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
  report.out(`${lines.join('\n')}\n`);
  if (record.error) {
    const step = record.error.step ? ` (step: ${record.error.step})` : '';
    report.err(`Error${step}: ${record.error.message}\n`);
  }
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
