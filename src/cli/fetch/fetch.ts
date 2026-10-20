import { loadConfig, redactSecrets, type LoadedConfig } from '../../config/load';
import type { Secrets } from '../../config/schema';
import { ExitCode } from '../../domain/schemas';
import { systemClock, type Clock } from '../../shared/clock';
import { mapWithConcurrency } from '../../shared/concurrency';
import { errorMessage } from '../../shared/errors';
import { MAX_CONCURRENT_SOURCES } from '../../sources/collect';
import { parseSince } from './plan/parseSince';
import { planFetch } from './plan/planFetch';
import { formatTable } from './report/formatTable';
import { formatTotals } from './report/totals';
import { createRunFolder } from './saveRun/runFolder';
import { saveRun } from './saveRun/saveRun';
import { fetchSource } from './sourceRun/fetchSource';

// `digest fetch` (W8-06): fetches the sources with the fetchers a run uses, and saves what came
// back (raw bodies) and what it was read into (items), so a source can be looked at without a
// run, a model or a lock. It writes the day's source folders of the data folder, as a run does
// (`store/layout.ts`): <dataDir>/<day>/<sourceId>/raw and formatted, and <day>/fetch-summary.json.

export interface FetchCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Only these source ids; all sources in the config when absent. */
  source?: string[];
  /** Collection window, e.g. "7d"; defaults to config.windowDays. */
  since?: string;
  /** Data folder to write into; default `config.dataDir`. A later fetch that day replaces a source's files. */
  out?: string;
}

/** Everything the command touches outside itself; tests replace it, `digest fetch` uses the defaults. */
export interface FetchCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  fetch: typeof fetch;
  clock: Clock;
  /** A relative `--out` and the data folder are resolved against this. */
  cwd: string;
  /** Per source, the feed and any article pages together. A run allows 10 s as well. */
  sourceTimeoutMs: number;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SOURCE_TIMEOUT_MS = 10_000;

const defaultDeps: FetchCommandDeps = {
  loadConfig: (options) => loadConfig(options),
  fetch: (input, init) => globalThis.fetch(input, init),
  clock: systemClock,
  cwd: process.cwd(),
  sourceTimeoutMs: SOURCE_TIMEOUT_MS,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** `digest fetch`: Fetches the sources only and saves raw and parsed data. Returns the process exit code. */
export async function fetchCommand(
  options: FetchCommandOptions,
  deps: Partial<FetchCommandDeps> = {},
): Promise<number> {
  const io: FetchCommandDeps = { ...defaultDeps, ...deps };
  let secrets: Secrets = {};
  const redact = (text: string): string => redactSecrets(text, secrets);
  try {
    const days = parseSince(options.since);
    const loaded = await io.loadConfig({ configPath: options.config });
    secrets = loaded.secrets;
    const plan = planFetch(options, days, loaded, io, redact);
    const folder = await createRunFolder(plan);
    const reports = await mapWithConcurrency(plan.sources, MAX_CONCURRENT_SOURCES, (source) =>
      fetchSource(source, plan.run),
    );

    io.stdout(redact(`${formatTable(reports)}\n\n${formatTotals(reports)}\n`));
    await saveRun(plan, reports, {
      generated: redact,
      collected: (text) => redactSecrets(text, { GITHUB_TOKEN: secrets.GITHUB_TOKEN }),
    });
    io.stdout(redact(`Saved to ${folder}\n`));
    return reports.every((report) => report.ok) ? ExitCode.Sent : ExitCode.Failed;
  } catch (error) {
    io.stderr(redact(`${errorMessage(error)}\n`));
    return ExitCode.Failed;
  }
}
