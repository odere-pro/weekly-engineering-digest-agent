import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createSourceArchive,
  type SavedSource,
} from '../../sources/adapters/archive/sourceArchive';
import { githubAtomAdapter } from '../../sources/adapters/githubAtomAdapter';
import { createGithubRestAdapter } from '../../sources/adapters/githubRestAdapter';
import {
  createFetcher,
  type SourceAnswer,
  type SourceEntries,
  type SourceTap,
} from '../../sources/adapters/pipeline';
import { rssAdapter } from '../../sources/adapters/rssAdapter';
import { loadConfig, redactSecrets, type LoadedConfig } from '../../config/load';
import type { Secrets } from '../../config/schema';
import { toJson } from '../../digest/runEnding';
import { ExitCode, type Item, type Source, type SourceKind } from '../../domain/schemas';
import type { FetchWindow, SourceFetcher } from '../../sources/SourceFetcher';
import { systemClock, type Clock } from '../../shared/clock';
import { DigestError, errorMessage } from '../../shared/errors';
import { withTimeout } from '../../shared/retry';
import { truncate } from '../../shared/text';
import { dayOf } from '../../store/layout';
import { formatDuration } from '../history/history';

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

const SUMMARY_FILE = 'fetch-summary.json';
const SOURCE_TIMEOUT_MS = 10_000;
/** As many at once as a run's collect step. */
const MAX_CONCURRENT_SOURCES = 4;
const DAY_MS = 86_400_000;
const SINCE_PATTERN = /^(\d+)d$/;
const MIN_SINCE_DAYS = 1;
const MAX_SINCE_DAYS = 31;
/** What summary.json keeps of an error text, as the run record does. */
const MAX_ERROR_CHARS = 300;
const MAX_TABLE_ERROR_CHARS = 80;
const COLUMN_GAP = '  ';
const TABLE_HEADER = ['Source', 'Status', 'HTTP', 'Items', 'Skipped', 'Time', 'Error'];
/** Control and format characters (escape codes, bidi overrides) have no place in a table. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

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

/** What one source came to. */
interface SourceReport {
  source: Source;
  ok: boolean;
  items: Item[];
  httpStatus: number | undefined;
  /** The URL that gave the last answer, after redirects. */
  answeredBy: string | undefined;
  /** Entries the adapter found and how many of them could not become items; undefined if unread. */
  entries: SourceEntries | undefined;
  durationMs: number;
  error: string | undefined;
}

/** What the command needs to fetch one source. */
interface FetchRun {
  fetchers: Readonly<Record<SourceKind, SourceFetcher>>;
  recorder: Recorder;
  window: Pick<FetchWindow, 'since' | 'until'>;
  maxItemsPerSource: number;
  clock: Clock;
  timeoutMs: number;
  /** Takes the secrets out of a text. */
  redact: (text: string) => string;
}

/** Everything decided before the first request, so a bad option fails before any network use. */
interface Plan {
  sources: Source[];
  /** The data folder written into. */
  root: string;
  /** The day folder below it (YYYY-MM-DD in the schedule's time zone). */
  day: string;
  startedAt: Date;
  windowDays: number;
  run: FetchRun;
}

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
    const folder = join(plan.root, plan.day);
    // Made before the first request, so an output location that cannot be written shows at once.
    await mkdir(folder, { recursive: true });
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

function planFetch(
  options: FetchCommandOptions,
  days: number | undefined,
  { config, secrets }: LoadedConfig,
  io: FetchCommandDeps,
  redact: (text: string) => string,
): Plan {
  const sources = selectSources(config.sources, options.source);
  const startedAt = io.clock.now();
  const root = resolve(io.cwd, options.out?.trim() || config.dataDir);
  const day = dayOf(startedAt, config.schedule.timeZone);
  const windowDays = days ?? config.windowDays;
  const recorder = createRecorder();
  const run: FetchRun = {
    fetchers: buildFetchers(secrets, io.fetch, recorder.tap),
    recorder,
    window: { since: new Date(startedAt.getTime() - windowDays * DAY_MS), until: startedAt },
    maxItemsPerSource: config.maxItemsPerSource,
    clock: io.clock,
    timeoutMs: io.sourceTimeoutMs,
    redact,
  };
  return { sources, root, day, startedAt, windowDays, run };
}

/** "7d" is 7 days, as for `digest run`. Undefined means "use the configured window". */
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

/** The named sources in config order; an id the config does not have is an error. */
function selectSources(all: readonly Source[], wanted: readonly string[] | undefined): Source[] {
  if (wanted === undefined || wanted.length === 0) return [...all];
  const known = new Set(all.map((source) => source.id));
  const unknown = [...new Set(wanted)].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new DigestError(
      `Unknown source: ${unknown.join(', ')}. Sources in the config: ${[...known].join(', ')}`,
    );
  }
  const chosen = new Set(wanted);
  return all.filter((source) => chosen.has(source.id));
}

// ---------------------------------------------------------------------------------------------
// Fetching

/** Collects what the debug tap sees, by source id. Nothing here touches the disk. */
interface Recorder {
  tap: SourceTap;
  answers: (sourceId: string) => SourceAnswer[];
  entries: (sourceId: string) => SourceEntries | undefined;
}

function createRecorder(): Recorder {
  const answers = new Map<string, SourceAnswer[]>();
  const entries = new Map<string, SourceEntries>();
  return {
    tap: {
      answer: (event) => {
        answers.set(event.sourceId, [...(answers.get(event.sourceId) ?? []), event]);
      },
      entries: (event) => {
        entries.set(event.sourceId, event);
      },
    },
    answers: (sourceId) => answers.get(sourceId) ?? [],
    entries: (sourceId) => entries.get(sourceId),
  };
}

/**
 * The fetchers of a run (same adapters, same pipeline) with the debug tap added, which a run
 * never has. The GitHub token picks the REST API over the Atom feed, as in the container.
 */
function buildFetchers(
  secrets: Secrets,
  fetchImpl: typeof fetch,
  tap: SourceTap,
): Record<SourceKind, SourceFetcher> {
  const token = secrets.GITHUB_TOKEN?.trim();
  return {
    rss: createFetcher(rssAdapter, { fetch: fetchImpl, tap }),
    github: createFetcher(token ? createGithubRestAdapter(token) : githubAtomAdapter, {
      fetch: fetchImpl,
      tap,
    }),
  };
}

type Outcome = { ok: true; items: Item[] } | { ok: false; error: unknown };

/** Once, with the run's time limit and no retries: what the source does the first time. */
async function fetchSource(source: Source, run: FetchRun): Promise<SourceReport> {
  const startedMs = run.clock.now().getTime();
  const window: FetchWindow = {
    ...run.window,
    maxItems: source.maxItems ?? run.maxItemsPerSource,
  };
  let outcome: Outcome;
  try {
    const items = await withTimeout(
      (signal) => run.fetchers[source.kind].fetch(source, window, signal),
      run.timeoutMs,
    );
    outcome = { ok: true, items };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const durationMs = run.clock.now().getTime() - startedMs;
  return reportOf(source, outcome, durationMs, run);
}

function reportOf(
  source: Source,
  outcome: Outcome,
  durationMs: number,
  run: FetchRun,
): SourceReport {
  const last = run.recorder.answers(source.id).at(-1);
  return {
    source,
    ok: outcome.ok,
    items: outcome.ok ? outcome.items : [],
    httpStatus: last?.status,
    answeredBy: last?.url,
    entries: run.recorder.entries(source.id),
    durationMs,
    error: outcome.ok ? undefined : errorText(outcome.error, run.redact),
  };
}

/** One line, free of control characters, without secrets (removed before any cut). */
function errorText(error: unknown, redact: (text: string) => string): string {
  const line = redact(errorMessage(error)).replace(/\s+/g, ' ').replace(UNPRINTABLE, '').trim();
  return truncate(line, MAX_ERROR_CHARS);
}

/** Runs `fn` over `inputs`, at most `limit` at a time; results keep the input order. */
async function mapWithConcurrency<T, R>(
  inputs: readonly T[],
  limit: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      results[index] = await fn(inputs[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------------------------
// Output

function formatTable(reports: readonly SourceReport[]): string {
  const rows = [
    TABLE_HEADER,
    ...reports.map((report) => [
      report.source.id,
      report.ok ? 'ok' : 'failed',
      report.httpStatus?.toString() ?? '-',
      report.items.length.toString(),
      report.entries?.skipped.toString() ?? '-',
      formatDuration(report.durationMs),
      truncate(report.error ?? '', MAX_TABLE_ERROR_CHARS),
    ]),
  ];
  const widths = TABLE_HEADER.map((_, col) =>
    Math.max(...rows.map((row) => row[col]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, col) => cell.padEnd(widths[col] ?? 0))
        .join(COLUMN_GAP)
        .trimEnd(),
    )
    .join('\n');
}

function formatTotals(reports: readonly SourceReport[]): string {
  const { sources, ok, failed, items } = totalsOf(reports);
  return `${plural(sources, 'source')}: ${ok} ok, ${failed} failed, ${plural(items, 'item')}`;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

function totalsOf(reports: readonly SourceReport[]): {
  sources: number;
  ok: number;
  failed: number;
  items: number;
} {
  const ok = reports.filter((report) => report.ok).length;
  return {
    sources: reports.length,
    ok,
    failed: reports.length - ok,
    items: reports.reduce((sum, report) => sum + report.items.length, 0),
  };
}

function summaryOf(
  { startedAt, windowDays, run }: Plan,
  reports: readonly SourceReport[],
  saved: readonly SavedSource[],
): object {
  return {
    startedAt: startedAt.toISOString(),
    window: {
      since: run.window.since.toISOString(),
      until: run.window.until.toISOString(),
      days: windowDays,
    },
    sources: reports.map((report, i) => ({
      id: report.source.id,
      kind: report.source.kind,
      status: report.ok ? 'ok' : 'failed',
      httpStatus: report.httpStatus ?? null,
      answeredBy: report.answeredBy ?? null,
      entries: report.entries?.parsed ?? null,
      skipped: report.entries?.skipped ?? null,
      items: report.items.length,
      durationMs: report.durationMs,
      error: report.error ?? null,
      raw: saved[i]?.raw ?? [],
      formatted: saved[i]?.formatted ?? null,
    })),
    totals: totalsOf(reports),
  };
}

/** Cleans a text of secrets. */
type Redact = (text: string) => string;

/**
 * Saves each source's answers and items (`SourceArchive`), then the summary, last, so a day folder
 * whose summary is there is complete. Texts the command wrote itself (errors, summary) are cleaned
 * of every secret; the collected data (response bodies, items) only of the GitHub token, the one
 * secret this command sends, so another secret that happens to be a common string cannot change
 * what a feed said.
 */
async function saveRun(
  plan: Plan,
  reports: readonly SourceReport[],
  redact: { generated: Redact; collected: Redact },
): Promise<void> {
  const archive = createSourceArchive({ dataDir: plan.root, redact: redact.collected });
  const saved: SavedSource[] = [];
  for (const report of reports) {
    const answers = plan.run.recorder.answers(report.source.id);
    const items = report.ok ? { items: report.items } : {};
    saved.push(await archive.save(plan.day, report.source.id, { answers, ...items }));
  }
  const summary = toJson(summaryOf(plan, reports, saved));
  await writeFile(join(plan.root, plan.day, SUMMARY_FILE), redact.generated(summary));
}
