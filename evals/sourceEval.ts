// Source conformance (W6-01): runs every fetcher over the response the recorder saved for its
// source, and counts what comes out. No network: the fetcher is handed a `fetch` that serves the
// recording. Used by `digest eval` (the two source metrics) and by test/evals/sources.test.ts.
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { createGithubReleasesFetcher } from '../src/adapters/sources/githubReleases.js';
import { createRssFetcher } from '../src/adapters/sources/rss.js';
import { DEFAULT_SOURCES } from '../src/config/defaultSources.js';
import { ItemSchema, type Item, type Source, type SourceKind } from '../src/core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../src/ports/SourceFetcher.js';
import { DigestError, errorMessage } from '../src/shared/errors.js';
import { itemIdFor } from '../src/shared/url.js';
import {
  SourceExpectedSchema,
  SourceResponseSchema,
  type SourceExpected,
  type SourceGap,
  type SourceResponse,
} from './schema.js';

/** A summary shorter than this is as good as none for the classifier and the writer. */
export const MIN_SUMMARY_CHARS = 40;

/** The hosts docs/sources.md says are contacted; test/evals/sourceEval.test.ts keeps them in sync. */
export const SOURCE_ALLOWED_HOSTS: readonly string[] = [
  'openai.com',
  'deepmind.google',
  'blog.google',
  'mistral.ai',
  'huggingface.co',
  'pytorch.org',
  'ollama.com',
  'github.com',
  'nodejs.org',
  'kubernetes.io',
  'www.docker.com',
  'github.blog',
  'aws.amazon.com',
  'docs.cloud.google.com',
  'www.microsoft.com',
];

/** Every recording is read with a window that holds all of its entries and the largest cap. */
const EVERYTHING: FetchWindow = {
  since: new Date(0),
  until: new Date(8.64e15),
  maxItems: 100,
};

/** One recorded source: what it served and the items that must come out of it. */
export interface SourceRecording {
  source: Source;
  response: SourceResponse;
  body: string;
  expected: SourceExpected;
}

/** Builds the fetcher of a kind around a `fetch`; the recording's `fetch` is passed in. */
export type SourceFetcherFactories = Readonly<
  Record<SourceKind, (fetchImpl: typeof fetch) => SourceFetcher>
>;

export const defaultFetcherFactories: SourceFetcherFactories = {
  rss: (fetchImpl) => createRssFetcher({ fetch: fetchImpl }),
  github: (fetchImpl) => createGithubReleasesFetcher({ fetch: fetchImpl }),
};

/** What running one source's fetcher over its recording produced. */
export interface SourceResult {
  sourceId: string;
  /** Items the fetcher returned. */
  parsed: number;
  /** Items the recording must yield. */
  expected: number;
  schemaInvalid: number;
  emptyTitle: number;
  /** Fewer than `MIN_SUMMARY_CHARS` characters. */
  emptySummary: number;
  badDate: number;
  /** The id is not the hash of the item's URL. */
  idMismatch: number;
  hostOutsideAllowlist: number;
  /** Set when the fetcher threw; `parsed` is then 0. */
  error?: string;
}

function serveRecording({ response, body }: SourceRecording): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body, {
        status: response.status ?? 200,
        headers: response.contentType ? { 'content-type': response.contentType } : {},
      }),
    );
}

/** The items a source's fetcher yields from its recording, for a window that covers all of it. */
export function fetchFromRecording(
  recording: SourceRecording,
  factories: SourceFetcherFactories,
): Promise<Item[]> {
  const fetcher = factories[recording.source.kind](serveRecording(recording));
  return fetcher.fetch(recording.source, EVERYTHING);
}

const withoutWww = (host: string): string => host.toLowerCase().replace(/^www\./, '');
const ALLOWED = new Set(SOURCE_ALLOWED_HOSTS.map(withoutWww));

function isOutsideAllowlist(url: string): boolean {
  try {
    return !ALLOWED.has(withoutWww(new URL(url).hostname));
  } catch {
    return true;
  }
}

function hasWrongId(item: Item): boolean {
  try {
    return item.id !== itemIdFor(item.url);
  } catch {
    return true;
  }
}

const count = (items: readonly Item[], test: (item: Item) => boolean): number =>
  items.filter(test).length;

function tally(source: SourceRecording, items: readonly Item[]): SourceResult {
  return {
    sourceId: source.source.id,
    parsed: items.length,
    expected: source.expected.items.length,
    schemaInvalid: count(items, (item) => !ItemSchema.safeParse(item).success),
    emptyTitle: count(items, (item) => item.title.trim() === ''),
    emptySummary: count(items, (item) => item.summary.trim().length < MIN_SUMMARY_CHARS),
    badDate: count(items, (item) => Number.isNaN(Date.parse(item.publishedAt))),
    idMismatch: count(items, hasWrongId),
    hostOutsideAllowlist: count(items, (item) => isOutsideAllowlist(item.url)),
  };
}

async function evaluateOne(
  recording: SourceRecording,
  factories: SourceFetcherFactories,
): Promise<SourceResult> {
  try {
    return tally(recording, await fetchFromRecording(recording, factories));
  } catch (error) {
    return { ...tally(recording, []), error: errorMessage(error) };
  }
}

/** Runs the fetcher of each source's kind over its recording, one source at a time. */
export async function evaluateSources(
  recordings: readonly SourceRecording[],
  factories: SourceFetcherFactories,
): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  for (const recording of recordings) results.push(await evaluateOne(recording, factories));
  return results;
}

const COMPARED_FIELDS = [
  'id',
  'sourceId',
  'kind',
  'url',
  'title',
  'publishedAt',
  'summary',
] as const;

function fieldProblems(actual: Item, expected: Item, gaps: readonly SourceGap[]): string[] {
  return COMPARED_FIELDS.filter((field) => !(field === 'summary' && gaps.includes('summary')))
    .filter((field) => actual[field] !== expected[field])
    .map(
      (field) =>
        `${expected.url}: ${field} is ${JSON.stringify(actual[field])}, expected ${JSON.stringify(expected[field])}`,
    );
}

/** What differs between the items a fetcher yielded and the expected ones, by item id. */
export function conformanceProblems(
  actual: readonly Item[],
  expected: readonly Item[],
  knownGaps: readonly SourceGap[],
): string[] {
  const actualById = new Map(actual.map((item) => [item.id, item]));
  const expectedIds = new Set(expected.map((item) => item.id));
  const missing = expected
    .filter((item) => !actualById.has(item.id))
    .map((item) => `missing ${item.url}`);
  const unexpected = actual
    .filter((item) => !expectedIds.has(item.id))
    .map((item) => `unexpected ${item.url}`);
  const changed = expected.flatMap((item) => {
    const found = actualById.get(item.id);
    return found ? fieldProblems(found, item, knownGaps) : [];
  });
  return [...missing, ...unexpected, ...changed];
}

// --- Loading evals/sources ------------------------------------------------------------------

async function readParsed<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DigestError(`${path} does not match its schema:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

async function folderNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new DigestError(`Cannot read ${dir}: ${errorMessage(error)}`, { cause: error });
  }
}

async function loadOne(
  dir: string,
  source: Source,
  response: SourceResponse,
  bodyFile: string,
): Promise<SourceRecording> {
  if (basename(bodyFile) !== bodyFile) {
    throw new DigestError(
      `${join(dir, 'response.json')}: bodyFile "${bodyFile}" leaves the folder`,
    );
  }
  const body = await readFile(join(dir, bodyFile), 'utf8').catch((error: unknown) => {
    throw new DigestError(`Cannot read ${join(dir, bodyFile)}: ${errorMessage(error)}`, {
      cause: error,
    });
  });
  const expected = await readParsed(join(dir, 'expected.json'), SourceExpectedSchema);
  return { source, response, body, expected };
}

/**
 * Every recording under `dir` (one folder per source id). A folder whose recording failed (an
 * error and no body) has nothing to check and is skipped. A missing `dir` is an empty set.
 */
export async function loadSourceRecordings(
  dir: string,
  sources: readonly Source[] = DEFAULT_SOURCES,
): Promise<SourceRecording[]> {
  const recordings: SourceRecording[] = [];
  for (const id of await folderNames(dir)) {
    const folder = join(dir, id);
    const source = sources.find((candidate) => candidate.id === id);
    if (!source) throw new DigestError(`${folder}: "${id}" is not a known source id`);
    const response = await readParsed(join(folder, 'response.json'), SourceResponseSchema);
    if (response.error !== undefined || response.bodyFile === undefined) continue;
    recordings.push(await loadOne(folder, source, response, response.bodyFile));
  }
  return recordings;
}
