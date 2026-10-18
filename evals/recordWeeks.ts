// `pnpm eval:record`: freezes the last 6 ISO weeks of live feed output into evals/weeks/<week>/items.json (W2-03).
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createGithubReleasesFetcher } from '../src/sources/adapters/githubReleases';
import { createRssFetcher } from '../src/sources/adapters/rss';
import { DEFAULT_SOURCES } from '../src/sources/defaultSources';
import { loadConfig, type LoadOptions } from '../src/config/load';
import { ItemSchema, type Item, type Source, type SourceKind } from '../src/domain/schemas';
import { collectStep, type CollectOutput } from '../src/sources/collect';
import { createRedactor } from '../src/observability/redact';
import type { SourceFetcher } from '../src/sources/SourceFetcher';
import { systemClock, type Clock } from '../src/shared/clock';
import { DigestError, errorMessage } from '../src/shared/errors';
import { isoWeekId, previousWeekIds } from '../src/shared/isoWeek';
import { noopLogger, type LogFields, type Logger } from '../src/shared/telemetry';
import { truncate } from '../src/shared/text';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const RECORDED_WEEKS = 6;
/**
 * Feeds are asked for this many items per source, so no week is cut short by the usual cap. The
 * replay does not serve that many: it caps each source as production does (see runEval.ts).
 */
export const RECORDED_ITEMS_PER_SOURCE = 100;
/** Weeks with fewer items are hard to label; feeds often keep only 10-20 entries. */
export const THIN_WEEK_MIN_ITEMS = 10;
const SUMMARY_MAX_CHARS = 200;
const DEFAULT_CONFIG_PATH = 'digest.config.json';
const DEFAULT_OUT_DIR = fileURLToPath(new URL('./weeks', import.meta.url));
const LABELS_TEMPLATE = { mustInclude: [], mustExclude: [], notes: '' };

export interface RecordWeeksOptions {
  /** Complete ISO weeks before the current one to record. */
  weeks: number;
  /** Folder that gets one `<week>/` folder per recorded week. */
  outDir: string;
}

/** Everything the recorder reaches outside itself with; tests replace all of it. */
export interface RecordWeeksDeps {
  /** Default: digest.config.json, else the default allowlist. */
  sources?: readonly Source[];
  /** Where to look for the config when `sources` is not given. */
  config?: LoadOptions;
  /** Default: the real RSS and GitHub fetchers. */
  fetchers?: Readonly<Partial<Record<SourceKind, SourceFetcher>>>;
  clock?: Clock;
  /** One report line per call. Default: console.log. */
  log?: (line: string) => void;
  /** Retries per source. Default: the collect step's own. */
  retries?: number;
}

export interface ResolvedSources {
  sources: readonly Source[];
  origin: 'config' | 'default';
  githubToken?: string;
}

interface WeekRecord {
  weekId: string;
  items: readonly Item[];
  /** Items an earlier run had already recorded; undefined when this run created items.json. */
  alreadyRecorded?: number;
}

/** Groups items by the ISO week (UTC) they were published in. Items outside `weekIds` are dropped. */
export function bucketByWeek(
  items: readonly Item[],
  weekIds: readonly string[],
): Map<string, Item[]> {
  const buckets = new Map<string, Item[]>(weekIds.map((weekId) => [weekId, []]));
  for (const item of items) {
    buckets.get(isoWeekId(new Date(item.publishedAt)))?.push(item);
  }
  return buckets;
}

/** The labeling aid: one numbered entry per item, with everything needed to pick by id. */
export function renderCandidates(weekId: string, items: readonly Item[]): string {
  const intro =
    items.length === 0
      ? 'No items were recorded for this week.'
      : `${pluralizeItems(items.length)}. Pick the 5 must-include and any must-exclude items, ` +
        'then copy their ids into labels.json.';
  const entries = items.map((item, index) => renderCandidate(index + 1, item));
  return [`# Candidates: ${weekId}`, intro, ...entries].join('\n\n') + '\n';
}

function renderCandidate(position: number, item: Item): string {
  const published = new Date(item.publishedAt).toISOString().slice(0, 10);
  return [
    `${position}. **${oneLine(item.title) || '(untitled)'}**`,
    `   - id: \`${item.id}\``,
    `   - source: ${item.sourceId}, published ${published}`,
    `   - url: ${item.url}`,
    `   - summary: ${truncate(oneLine(item.summary), SUMMARY_MAX_CHARS) || '(none)'}`,
  ].join('\n');
}

/** The sources to record: the config's when digest.config.json exists, else the default allowlist. */
export async function resolveSources(options: LoadOptions = {}): Promise<ResolvedSources> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  if (!(await fileExists(configPath))) return { sources: DEFAULT_SOURCES, origin: 'default' };
  // A config that exists but is broken must fail loudly, not quietly fall back to the defaults.
  const loaded = await loadConfig({ ...options, configPath });
  return {
    sources: loaded.config.sources,
    origin: 'config',
    githubToken: loaded.secrets.GITHUB_TOKEN,
  };
}

/**
 * Records the last `weeks` complete ISO weeks of feed output under `outDir`, prints counts, and
 * returns the recorded week ids, oldest first. A re-run only adds: items already in items.json are
 * kept, because feeds drop old entries and replacing the file would shrink a labeled week, while
 * items missed by a failed source on an earlier run are filled in.
 */
export async function recordWeeks(
  options: RecordWeeksOptions,
  deps: RecordWeeksDeps = {},
): Promise<string[]> {
  const { weeks, outDir } = options;
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new DigestError(`Cannot record ${weeks} weeks: use a whole number of 1 or more.`);
  }
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const weekIds = previousWeekIds(isoWeekId(now), weeks).toReversed();

  const resolved = deps.sources
    ? { sources: deps.sources, origin: 'config' as const }
    : await resolveSources(deps.config);
  const fetchers =
    deps.fetchers ?? createDefaultFetchers(resolved.githubToken, reportLogger(log, resolved));
  const collected = await collectStep(
    {
      sources: resolved.sources.map((source) => ({
        ...source,
        maxItems: RECORDED_ITEMS_PER_SOURCE,
      })),
      since: new Date(now.getTime() - (weeks + 1) * WEEK_MS),
      until: now,
      maxItemsPerSource: RECORDED_ITEMS_PER_SOURCE,
    },
    { fetchers, logger: noopLogger, clock, retries: deps.retries },
  );

  const buckets = bucketByWeek(collected.items, weekIds);
  // allSettled: when one week fails, the others still finish writing before this rejects, so no
  // write outlives the call (a caller cleaning up the folder would otherwise race them).
  const settled = await Promise.allSettled(
    [...buckets].map(([weekId, items]) => recordWeek(join(outDir, weekId), weekId, items)),
  );
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  const records = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  for (const line of reportLines(outDir, records, resolved, collected.failedSources)) log(line);
  return weekIds;
}

async function recordWeek(
  weekDir: string,
  weekId: string,
  collected: readonly Item[],
): Promise<WeekRecord> {
  await mkdir(weekDir, { recursive: true });
  const itemsPath = join(weekDir, 'items.json');
  const recorded = await readRecordedItems(itemsPath);
  const items = mergeItems(recorded ?? [], collected);
  if (recorded === undefined || items.length > recorded.length) {
    await writeFile(itemsPath, await toJson(itemsPath, items));
  }

  const labelsPath = join(weekDir, 'labels.json');
  await writeIfAbsent(labelsPath, await toJson(labelsPath, LABELS_TEMPLATE));

  // Derived from items.json, so it is rewritten every time and never disagrees with it.
  const candidatesPath = join(weekDir, 'candidates.md');
  await writeFile(
    candidatesPath,
    await formatLikeRepo(candidatesPath, renderCandidates(weekId, items)),
  );
  return { weekId, items, alreadyRecorded: recorded?.length };
}

/** The items an earlier run recorded, undefined when there is no items.json yet. */
async function readRecordedItems(path: string): Promise<Item[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    return ItemSchema.array().parse(JSON.parse(raw));
  } catch (cause) {
    throw new DigestError(
      `Cannot reuse ${path}: ${errorMessage(cause)}. Fix it or delete it to record again.`,
      { cause },
    );
  }
}

/** Recorded items stay as they are; collected items not recorded yet are added, newest first. */
function mergeItems(recorded: readonly Item[], collected: readonly Item[]): Item[] {
  const known = new Set(recorded.map((item) => item.id));
  const added = collected.filter((item) => !known.has(item.id));
  return [...recorded, ...added].toSorted(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}

/** Creates `path` only when it does not exist yet; true when this call created it. */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) return false;
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function toJson(path: string, value: unknown): Promise<string> {
  return formatLikeRepo(path, JSON.stringify(value, null, 2));
}

/** Formats with the repo's prettier config, so committed recordings pass `pnpm format:check`. */
async function formatLikeRepo(path: string, content: string): Promise<string> {
  const options = await resolveConfig(path);
  return format(content, { ...options, filepath: path });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function createDefaultFetchers(
  githubToken: string | undefined,
  logger: Logger,
): Record<SourceKind, SourceFetcher> {
  return {
    rss: createRssFetcher({ logger }),
    github: createGithubReleasesFetcher({ token: githubToken, logger }),
  };
}

/**
 * The logger the default fetchers get. A feed entry they skip means a recording that lacks it, so
 * a warning or an error becomes a line in the report; lower levels stay out of it. A line is one
 * line and has the GitHub token taken out, like every other log line of the app.
 */
function reportLogger(log: (line: string) => void, { githubToken }: ResolvedSources): Logger {
  const redactor = createRedactor(githubToken === undefined ? [] : [githubToken]);
  const lineOf = (label: string, message: string, fields: LogFields): string =>
    oneLine(redactor.text(`${label}: ${message}${detailsOf(redactor.fields(fields))}`));
  const levelLogger = (bindings: LogFields): Logger => {
    const report = (label: string) => (message: string, fields: LogFields) => {
      log(lineOf(label, message, { ...bindings, ...fields }));
    };
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: report('WARNING'),
      error: report('ERROR'),
      child: (fields) => levelLogger({ ...bindings, ...fields }),
    };
  };
  return levelLogger({});
}

/** ` (key=value key=value)`, or nothing without fields. */
function detailsOf(fields: LogFields): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${displayed(value)}`);
  return pairs.length === 0 ? '' : ` (${pairs.join(' ')})`;
}

function displayed(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pluralizeItems(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

function reportLines(
  outDir: string,
  records: readonly WeekRecord[],
  resolved: Pick<ResolvedSources, 'sources' | 'origin'>,
  failedSources: CollectOutput['failedSources'],
): string[] {
  const first = records.at(0)?.weekId;
  const last = records.at(-1)?.weekId;
  return [
    `Recorded ${records.length} weeks (${first} to ${last}) in ${outDir}`,
    `Sources: ${resolved.sources.length} (${resolved.origin === 'config' ? 'digest.config.json' : 'default allowlist'})`,
    'Items per week:',
    ...records.map(weekLine),
    'Items per source, all recorded weeks:',
    ...sourceLines(resolved.sources, records),
    ...failedLines(failedSources),
  ];
}

function weekLine(record: WeekRecord): string {
  const count = pluralizeItems(record.items.length).padStart(8);
  const notes = [
    record.items.length < THIN_WEEK_MIN_ITEMS
      ? `WARNING: fewer than ${THIN_WEEK_MIN_ITEMS} items; feeds often keep only 10-20 entries`
      : undefined,
    record.alreadyRecorded === undefined
      ? undefined
      : `${record.alreadyRecorded} already recorded, ${record.items.length - record.alreadyRecorded} added`,
  ].filter((note) => note !== undefined);
  return `  ${record.weekId}  ${count}${notes.length > 0 ? `  ${notes.join('; ')}` : ''}`;
}

function sourceLines(sources: readonly Source[], records: readonly WeekRecord[]): string[] {
  const counts = new Map<string, number>(sources.map((source) => [source.id, 0]));
  for (const { sourceId } of records.flatMap((record) => record.items)) {
    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
  }
  const width = Math.max(...[...counts.keys()].map((sourceId) => sourceId.length));
  return [...counts].map(([sourceId, count]) => `  ${sourceId.padEnd(width)}  ${count}`);
}

function failedLines(failedSources: CollectOutput['failedSources']): string[] {
  if (failedSources.length === 0) return [];
  const details = failedSources.map(({ sourceId, error }) => `${sourceId} (${error})`);
  return [
    `WARNING: ${failedSources.length} failed sources: ${details.join('; ')}`,
    'Their items are missing, so some weeks are incomplete. Run pnpm eval:record again to fill them in; recorded items are kept.',
  ];
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  recordWeeks({ weeks: RECORDED_WEEKS, outDir: DEFAULT_OUT_DIR }).catch((error: unknown) => {
    console.error(`eval:record failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
