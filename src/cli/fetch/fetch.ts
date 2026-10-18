import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import { formatDuration } from '../history/history';

// `digest fetch` (W8-06): fetches the sources with the fetchers a run uses, and saves what came
// back (raw bodies) and what it was read into (items), so a source can be looked at without a
// run, a model or a lock. It writes only below the output folder, never into the data folder.

export interface FetchCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Only these source ids; all sources in the config when absent. */
  source?: string[];
  /** Collection window, e.g. "7d"; defaults to config.windowDays. */
  since?: string;
  /** Folder for the output; each fetch gets a timestamped folder below it. Default dist/fetch. */
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

const DEFAULT_OUT = join('dist', 'fetch');
const RAW_DIR = 'raw';
const ITEMS_FILE = 'items.json';
const SUMMARY_FILE = 'summary.json';
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
const JSON_START = /^[[{]/;
const HTML_START = /^<(?:!doctype\s+html|html|head|body)\b/i;
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

/** A response body to save, with the name it is saved under below the run folder. */
interface RawFile {
  path: string;
  body: string;
}

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
  /** The body of the last answer, when it had one. */
  raw: RawFile | undefined;
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
  folder: string;
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
    await createRunFolder(plan.folder);
    const reports = await mapWithConcurrency(plan.sources, MAX_CONCURRENT_SOURCES, (source) =>
      fetchSource(source, plan.run),
    );

    io.stdout(redact(`${formatTable(reports)}\n\n${formatTotals(reports)}\n`));
    await saveRun(plan.folder, reports, summaryOf(plan, reports), {
      generated: redact,
      collected: (text) => redactSecrets(text, { GITHUB_TOKEN: secrets.GITHUB_TOKEN }),
    });
    io.stdout(redact(`Saved to ${plan.folder}\n`));
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
  const folder = runFolder(options.out, config.dataDir, io.cwd, startedAt);
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
  return { sources, folder, startedAt, windowDays, run };
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

/** `<out>/<timestamp>`; refuses an output folder inside the data folder, which belongs to runs. */
function runFolder(out: string | undefined, dataDir: string, cwd: string, at: Date): string {
  const root = resolve(cwd, out?.trim() || DEFAULT_OUT);
  if (isInside(resolve(cwd, dataDir), root)) {
    throw new DigestError(
      `--out must not be inside the data folder (${dataDir}); choose another folder.`,
    );
  }
  return join(root, at.toISOString().replace(/[:.]/g, '-'));
}

/** A new, empty folder. Made before the first request, so an output location that cannot be written shows at once. */
async function createRunFolder(folder: string): Promise<void> {
  await mkdir(dirname(folder), { recursive: true });
  try {
    await mkdir(folder);
  } catch (error) {
    const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
    if (exists) throw new DigestError(`${folder} already exists; run the command again.`);
    throw error;
  }
  await mkdir(join(folder, RAW_DIR));
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
    raw: last && rawFile(source.id, last),
  };
}

/** One line, free of control characters, without secrets (removed before any cut). */
function errorText(error: unknown, redact: (text: string) => string): string {
  const line = redact(errorMessage(error)).replace(/\s+/g, ' ').replace(UNPRINTABLE, '').trim();
  return truncate(line, MAX_ERROR_CHARS);
}

/** The body of an answer, with its file name; undefined for an answer without one. */
function rawFile(sourceId: string, answer: SourceAnswer): RawFile | undefined {
  if (answer.body === '') return undefined;
  return { path: `${RAW_DIR}/${sourceId}.${rawExtension(answer)}`, body: answer.body };
}

/** From the content type the server sent; else from the first characters of the body. */
function rawExtension({ contentType, body }: SourceAnswer): 'xml' | 'json' | 'html' {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('html')) return 'html';
  if (/xml|atom|rss/.test(type)) return 'xml';
  const start = body.trimStart().slice(0, 32);
  if (JSON_START.test(start)) return 'json';
  if (HTML_START.test(start)) return 'html';
  return start.startsWith('<') ? 'xml' : 'html';
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

function summaryOf({ startedAt, windowDays, run }: Plan, reports: readonly SourceReport[]): object {
  return {
    startedAt: startedAt.toISOString(),
    window: {
      since: run.window.since.toISOString(),
      until: run.window.until.toISOString(),
      days: windowDays,
    },
    sources: reports.map((report) => ({
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
      raw: report.raw ? [report.raw.path] : [],
    })),
    totals: totalsOf(reports),
  };
}

/** Cleans a text of secrets. */
type Redact = (text: string) => string;

/**
 * Writes into the folder made before the fetch; the summary goes last, so a folder that has one is
 * complete. Texts the command wrote itself (errors, summary) are cleaned of every secret; the
 * collected data (response bodies, items) only of the GitHub token, the one secret this command
 * sends, so another secret that happens to be a common string cannot change what a feed said.
 */
async function saveRun(
  folder: string,
  reports: readonly SourceReport[],
  summary: object,
  redact: { generated: Redact; collected: Redact },
): Promise<void> {
  for (const file of reports.flatMap((report) => (report.raw ? [report.raw] : []))) {
    await writeFile(join(folder, file.path), redact.collected(file.body));
  }
  const items = reports.flatMap((report) => report.items);
  await writeFile(join(folder, ITEMS_FILE), redact.collected(toJson(items)));
  await writeFile(join(folder, SUMMARY_FILE), redact.generated(toJson(summary)));
}
