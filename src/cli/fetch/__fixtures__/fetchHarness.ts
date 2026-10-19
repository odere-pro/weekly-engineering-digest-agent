import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { PROFILES } from '../../../config/profiles';
import type { LoadedConfig } from '../../../config/load';
import type { ConfigInput, Secrets } from '../../../config/schema';
import type { Item, Source } from '../../../domain/schemas';
import { makeConfig } from '../../../../test/builders';
import { fixedClock } from '../../../../test/fakes';
import type { FetchCommandDeps } from '../fetch';

// The scripted network and the temp data folder that the `digest fetch` tests share.

export const NOW = '2026-10-13T00:00:00Z';
/** NOW in the config's time zone (Europe/Berlin): the day folder of the fetch. */
export const DAY = '2026-10-13';

/** A recorded sample of a feed or a GitHub answer, from the sources' fixtures. */
export const fixture = (path: string): Promise<string> =>
  readFile(
    join(import.meta.dirname, '..', '..', '..', 'sources', 'adapters', '__fixtures__', path),
    'utf8',
  );

export const RSS: Source = { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' };
export const ATOM: Source = {
  id: 'example-atom',
  kind: 'rss',
  url: 'https://example.org/feed.xml',
};
export const REPO: Source = {
  id: 'acme-widgets',
  kind: 'github',
  url: 'https://github.com/acme/widgets',
};
export const REPO_ATOM_URL = 'https://github.com/acme/widgets/releases.atom';
export const REPO_API_URL = 'https://api.github.com/repos/acme/widgets/releases?per_page=20';
export const TOKEN = 'ghp_TESTTOKEN0123456789';

export interface Served {
  status?: number;
  body?: string;
  type?: string;
}
export type Route = Served | Error | 'hang';

export interface Call {
  url: string;
  headers: Headers;
}

/** A fetch fake: each url maps to a canned answer; any other url is a 404. */
export function serving(routes: Record<string, Route>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url];
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    if (route instanceof Error) return Promise.reject(route);
    if (route === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason: unknown = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        });
      });
    }
    return Promise.resolve(
      new Response(route.body ?? '', {
        status: route.status ?? 200,
        headers: route.type ? { 'content-type': route.type } : {},
      }),
    );
  };
  return { fetch: fake, calls };
}

export async function defaultRoutes(): Promise<Record<string, Route>> {
  return {
    [RSS.url]: { body: await fixture('feeds/rss2.xml'), type: 'application/rss+xml' },
    [ATOM.url]: { body: await fixture('feeds/atom.xml'), type: 'application/atom+xml' },
    [REPO_ATOM_URL]: { body: await fixture('github/releases.atom'), type: 'application/atom+xml' },
    [REPO_API_URL]: {
      body: await fixture('github/releases.json'),
      type: 'application/json; charset=utf-8',
    },
  };
}

/** A fresh temp folder for each test; the getter gives the current one. */
export function useTempDir(): () => string {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-fetch-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

export interface Harness {
  deps: FetchCommandDeps;
  dir: string;
  out: () => string;
  err: () => string;
  calls: Call[];
  loadConfig: ReturnType<typeof vi.fn<FetchCommandDeps['loadConfig']>>;
}

export interface HarnessOptions {
  sources?: Source[];
  config?: Partial<ConfigInput>;
  secrets?: Secrets;
  routes?: Record<string, Route>;
  clock?: FetchCommandDeps['clock'];
  sourceTimeoutMs?: number;
}

/** The command's deps with the scripted network, the config loaded from memory and captured output. */
export async function harness(dir: string, options: HarnessOptions = {}): Promise<Harness> {
  const served = serving(options.routes ?? (await defaultRoutes()));
  const out: string[] = [];
  const err: string[] = [];
  const loaded: LoadedConfig = {
    config: makeConfig({
      sources: options.sources ?? [RSS],
      dataDir: join(dir, 'data'),
      ...options.config,
    }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: options.secrets ?? {},
    profile: PROFILES.quality,
    platform: { os: 'darwin', arch: 'arm64' },
    configPath: join(dir, 'digest.config.json'),
  };
  const loadConfig = vi.fn<FetchCommandDeps['loadConfig']>(() => Promise.resolve(loaded));
  const deps: FetchCommandDeps = {
    loadConfig,
    fetch: served.fetch,
    clock: options.clock ?? fixedClock(NOW),
    cwd: dir,
    sourceTimeoutMs: options.sourceTimeoutMs ?? 5_000,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return {
    deps,
    dir,
    out: () => out.join(''),
    err: () => err.join(''),
    calls: served.calls,
    loadConfig,
  };
}

/** Where a fetch with the harness's config leaves its files (the config's data folder). */
export function pathsIn(dir: string): {
  outputRoot: string;
  runFolder: string;
  summaryPath: string;
  rawPath: (sourceId: string, extension: string) => string;
  itemsPath: (sourceId: string) => string;
} {
  const outputRoot = join(dir, 'data');
  const runFolder = join(outputRoot, DAY);
  return {
    outputRoot,
    runFolder,
    summaryPath: join(runFolder, 'fetch-summary.json'),
    rawPath: (sourceId, extension) => join(runFolder, sourceId, 'raw', `response-1.${extension}`),
    itemsPath: (sourceId) => join(runFolder, sourceId, 'formatted', 'items.json'),
  };
}

export const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/** The items saved for these sources, one after the other. */
export async function savedItems(dir: string, ...sourceIds: string[]): Promise<Item[]> {
  const { itemsPath } = pathsIn(dir);
  const lists = await Promise.all(
    sourceIds.map(async (id) => (await readJson(itemsPath(id))) as Item[]),
  );
  return lists.flat();
}

/** What one source leaves in the day folder after a fetch that worked. */
export const sourceFiles = (sourceId: string, extension: string): string[] => [
  `${sourceId}/formatted/items.json`,
  `${sourceId}/raw/response-1.${extension}`,
  `${sourceId}/raw/responses.json`,
];

/** Every file below `root`, relative and sorted. */
export async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

/** The rows of the table on stdout: each line split on runs of two or more spaces. */
export function tableRows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .filter((line) => /^\S/.test(line) && line.includes('  '))
    .map((line) => line.trimEnd().split(/\s{2,}/));
}

export interface SummarySource {
  id: string;
  kind: string;
  status: string;
  httpStatus: number | null;
  entries: number | null;
  skipped: number | null;
  items: number;
  durationMs: number;
  error: string | null;
  raw: string[];
}

export interface Summary {
  startedAt: string;
  window: { since: string; until: string; days: number };
  sources: SummarySource[];
  totals: { sources: number; ok: number; failed: number; items: number };
}
