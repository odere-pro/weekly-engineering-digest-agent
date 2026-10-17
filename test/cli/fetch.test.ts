import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGithubReleasesFetcher } from '../../src/adapters/sources/githubReleases.js';
import { createRssFetcher } from '../../src/adapters/sources/rss.js';
import { fetchCommand, type FetchCommandDeps } from '../../src/cli/fetch.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { PROFILES } from '../../src/config/profiles.js';
import type { ConfigInput, Secrets } from '../../src/config/schema.js';
import type { Item, Source } from '../../src/core/schemas.js';
import { DigestError } from '../../src/shared/errors.js';
import { makeConfig } from '../builders.js';
import { fixedClock } from '../fakes/index.js';

const NOW = '2026-10-13T00:00:00Z';
const STAMP = '2026-10-13T00-00-00-000Z';

const fixture = (path: string): Promise<string> =>
  readFile(join(import.meta.dirname, '..', 'fixtures', path), 'utf8');

const RSS: Source = { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' };
const ATOM: Source = { id: 'example-atom', kind: 'rss', url: 'https://example.org/feed.xml' };
const REPO: Source = { id: 'acme-widgets', kind: 'github', url: 'https://github.com/acme/widgets' };
const REPO_ATOM_URL = 'https://github.com/acme/widgets/releases.atom';
const REPO_API_URL = 'https://api.github.com/repos/acme/widgets/releases?per_page=20';
const TOKEN = 'ghp_TESTTOKEN0123456789';

interface Served {
  status?: number;
  body?: string;
  type?: string;
}
type Route = Served | Error | 'hang';

interface Call {
  url: string;
  headers: Headers;
}

/** A fetch fake: each url maps to a canned answer; any other url is a 404. */
function serving(routes: Record<string, Route>): { fetch: typeof fetch; calls: Call[] } {
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

interface Harness {
  deps: FetchCommandDeps;
  dir: string;
  out: () => string;
  err: () => string;
  calls: Call[];
  loadConfig: ReturnType<typeof vi.fn<FetchCommandDeps['loadConfig']>>;
}

interface HarnessOptions {
  sources?: Source[];
  config?: Partial<ConfigInput>;
  secrets?: Secrets;
  routes?: Record<string, Route>;
  clock?: FetchCommandDeps['clock'];
  sourceTimeoutMs?: number;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'digest-fetch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function defaultRoutes(): Promise<Record<string, Route>> {
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

async function harness(options: HarnessOptions = {}): Promise<Harness> {
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

const outputRoot = (): string => join(dir, 'dist', 'fetch');
const runFolder = (): string => join(outputRoot(), STAMP);
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

/** The rows of the table on stdout: each line split on runs of two or more spaces. */
function tableRows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .filter((line) => /^\S/.test(line) && line.includes('  '))
    .map((line) => line.trimEnd().split(/\s{2,}/));
}

interface SummarySource {
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
interface Summary {
  startedAt: string;
  window: { since: string; until: string; days: number };
  sources: SummarySource[];
  totals: { sources: number; ok: number; failed: number; items: number };
}

describe('fetchCommand: what it saves', () => {
  it('writes raw bodies, items.json and summary.json under <out>/<timestamp>/', async () => {
    const h = await harness({ sources: [RSS, REPO] });

    const code = await fetchCommand({ out: join(dir, 'saved') }, h.deps);

    expect(code).toBe(0);
    expect(await allFiles(join(dir, 'saved', STAMP))).toEqual([
      'items.json',
      'raw/acme-widgets.xml',
      'raw/example-feed.xml',
      'summary.json',
    ]);
  });

  it('saves a response body as the fetcher read it', async () => {
    const h = await harness();

    await fetchCommand({}, h.deps);

    expect(await readFile(join(runFolder(), 'raw', 'example-feed.xml'), 'utf8')).toBe(
      await fixture('feeds/rss2.xml'),
    );
  });

  it('defaults the output folder to dist/fetch under the working directory', async () => {
    const h = await harness();

    await fetchCommand({}, h.deps);

    expect(await readdir(outputRoot())).toEqual([STAMP]);
  });

  it('puts the parsed items of every source in items.json, in config order', async () => {
    const h = await harness({ sources: [ATOM, RSS] });

    await fetchCommand({}, h.deps);

    const items = (await readJson(join(runFolder(), 'items.json'))) as Item[];
    expect(items.map((item) => item.sourceId)).toEqual([
      'example-atom',
      'example-atom',
      'example-feed',
      'example-feed',
    ]);
    expect(items.map((item) => item.title)).toEqual([
      'Terraform 2.0',
      'Go 1.27',
      'Kubernetes 1.40 released',
      'Postgres 19 beta',
    ]);
  });

  it('saves what the fetchers of a run return, item for item', async () => {
    const routes = await defaultRoutes();
    const h = await harness({ sources: [RSS, ATOM, REPO], routes });
    const window = {
      since: new Date('2026-10-06T00:00:00Z'),
      until: new Date(NOW),
      maxItems: 20,
    };
    const rss = createRssFetcher({ fetch: serving(routes).fetch });
    const github = createGithubReleasesFetcher({ fetch: serving(routes).fetch });
    const expected = [
      ...(await rss.fetch(RSS, window)),
      ...(await rss.fetch(ATOM, window)),
      ...(await github.fetch(REPO, window)),
    ];

    await fetchCommand({}, h.deps);

    expect(await readJson(join(runFolder(), 'items.json'))).toEqual(expected);
  });

  it('describes the window and every source in summary.json', async () => {
    const h = await harness({ sources: [RSS, REPO] });

    await fetchCommand({}, h.deps);

    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.startedAt).toBe('2026-10-13T00:00:00.000Z');
    expect(summary.window).toEqual({
      since: '2026-10-06T00:00:00.000Z',
      until: '2026-10-13T00:00:00.000Z',
      days: 7,
    });
    expect(summary.sources).toEqual([
      {
        id: 'example-feed',
        kind: 'rss',
        status: 'ok',
        httpStatus: 200,
        answeredBy: RSS.url,
        entries: 7,
        skipped: 3,
        items: 2,
        durationMs: 0,
        error: null,
        raw: ['raw/example-feed.xml'],
      },
      expect.objectContaining({
        id: 'acme-widgets',
        kind: 'github',
        status: 'ok',
        httpStatus: 200,
        answeredBy: REPO_ATOM_URL,
        entries: 5,
        skipped: 0,
        items: 3,
        raw: ['raw/acme-widgets.xml'],
      }),
    ]);
    expect(summary.totals).toEqual({ sources: 2, ok: 2, failed: 0, items: 5 });
  });
});

describe('fetchCommand: raw file extension', () => {
  const cases: [string, string | undefined, string, string][] = [
    ['an RSS content type', 'application/rss+xml', '<rss/>', 'xml'],
    ['an Atom content type', 'application/atom+xml; charset=utf-8', '<feed/>', 'xml'],
    ['a text/xml content type', 'text/xml', '<rss/>', 'xml'],
    ['a JSON content type', 'application/vnd.github+json', '[]', 'json'],
    ['an HTML content type', 'text/html; charset=utf-8', '<p>hi</p>', 'html'],
    ['no content type and a JSON object', undefined, '{"a":1}', 'json'],
    ['no content type and a JSON list', undefined, ' [1]', 'json'],
    ['no content type and an XML declaration', undefined, '<?xml version="1.0"?><rss/>', 'xml'],
    ['no content type and a feed root', undefined, '<rss version="2.0"></rss>', 'xml'],
    ['no content type and an HTML page', undefined, '<!DOCTYPE html><html></html>', 'html'],
    ['plain text that says nothing', 'text/plain', 'Service busy, try later', 'html'],
  ];

  it.each(cases)('uses the right one for %s', async (_name, type, body, extension) => {
    const routes = { [RSS.url]: { body, ...(type ? { type } : {}) } };
    const h = await harness({ routes });

    await fetchCommand({}, h.deps);

    expect(await allFiles(join(runFolder(), 'raw'))).toEqual([`example-feed.${extension}`]);
    expect(await readFile(join(runFolder(), 'raw', `example-feed.${extension}`), 'utf8')).toBe(
      body,
    );
  });
});

describe('fetchCommand: the table and the exit code', () => {
  it('prints one row per source and exits 0 when every source worked', async () => {
    const h = await harness({ sources: [RSS, REPO] });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(0);
    expect(tableRows(h.out())).toEqual([
      ['Source', 'Status', 'HTTP', 'Items', 'Skipped', 'Time', 'Error'],
      ['example-feed', 'ok', '200', '2', '3', '0.0s'],
      ['acme-widgets', 'ok', '200', '3', '0', '0.0s'],
    ]);
  });

  it('ends with the totals and where the files are', async () => {
    const h = await harness({ sources: [RSS, REPO] });

    await fetchCommand({}, h.deps);

    expect(h.out()).toContain('2 sources: 2 ok, 0 failed, 5 items');
    expect(h.out()).toContain(`Saved to ${runFolder()}`);
  });

  it('shows how long each source took, from the clock', async () => {
    let calls = 0;
    const clock = { now: () => new Date(Date.parse(NOW) + 1_500 * calls++) };
    const h = await harness({ clock });

    await fetchCommand({}, h.deps);

    expect(tableRows(h.out())[1]?.at(-1)).toBe('1.5s');
    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.sources[0]?.durationMs).toBe(1_500);
  });

  it('exits 1 when a source answers with an error, names it, and still saves the others', async () => {
    const routes = { ...(await defaultRoutes()), [ATOM.url]: { status: 500, body: 'oops' } };
    const h = await harness({ sources: [RSS, ATOM], routes });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    const rows = tableRows(h.out());
    expect(rows[1]).toEqual(['example-feed', 'ok', '200', '2', '3', '0.0s']);
    expect(rows[2]).toEqual([
      'example-atom',
      'failed',
      '500',
      '0',
      '-',
      '0.0s',
      'HTTP 500 fetching example-atom',
    ]);
    expect(h.out()).toContain('2 sources: 1 ok, 1 failed, 2 items');
    expect(await allFiles(runFolder())).toEqual([
      'items.json',
      'raw/example-atom.html',
      'raw/example-feed.xml',
      'summary.json',
    ]);
    expect(await readFile(join(runFolder(), 'raw', 'example-atom.html'), 'utf8')).toBe('oops');
    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.sources[1]).toEqual(
      expect.objectContaining({
        status: 'failed',
        httpStatus: 500,
        entries: null,
        skipped: null,
        items: 0,
        error: 'HTTP 500 fetching example-atom',
        raw: ['raw/example-atom.html'],
      }),
    );
  });

  it('keeps the body of a feed that cannot be parsed, to look at', async () => {
    const routes = { [RSS.url]: { body: '<rss><channel><item></channel>', type: 'text/xml' } };
    const h = await harness({ routes });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(await readFile(join(runFolder(), 'raw', 'example-feed.xml'), 'utf8')).toBe(
      '<rss><channel><item></channel>',
    );
    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.sources[0]).toEqual(
      expect.objectContaining({ status: 'failed', httpStatus: 200 }),
    );
    expect(summary.sources[0]?.error).toMatch(/Cannot parse feed example-feed/);
  });

  it('reports a network failure without an HTTP status', async () => {
    const h = await harness({ routes: { [RSS.url]: new TypeError('fetch failed') } });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(tableRows(h.out())[1]).toEqual([
      'example-feed',
      'failed',
      '-',
      '0',
      '-',
      '0.0s',
      'fetch failed',
    ]);
    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.sources[0]?.httpStatus).toBeNull();
  });

  it('gives a source that does not answer in time up and says so', async () => {
    const h = await harness({ routes: { [RSS.url]: 'hang' }, sourceTimeoutMs: 20 });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(tableRows(h.out())[1]?.at(-1)).toBe('Timed out after 20 ms');
  });

  it('shows a one-line, cut-down error in the table and the longer one in summary.json', async () => {
    const message = `bad\u001b[31m\u009b feed\u202Egnp\nsecond line ${'long '.repeat(200)}`;
    const h = await harness({ routes: { [RSS.url]: new Error(message) } });

    await fetchCommand({}, h.deps);

    const shown = tableRows(h.out())[1]?.at(-1) ?? '';
    expect(shown).toMatch(/^bad\[31m feedgnp second line long/);
    expect(shown.length).toBeLessThanOrEqual(80);
    for (const code of [0x1b, 0x9b, 0x202e]) {
      expect(h.out()).not.toContain(String.fromCharCode(code));
    }
    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.sources[0]?.error?.length).toBeLessThanOrEqual(300);
    expect(summary.sources[0]?.error?.length).toBeGreaterThan(80);
  });

  it('runs every source even when the first one fails', async () => {
    const routes = { ...(await defaultRoutes()), [RSS.url]: { status: 503 } };
    const h = await harness({ sources: [RSS, ATOM, REPO], routes });

    await fetchCommand({}, h.deps);

    expect(tableRows(h.out()).map((row) => row[1])).toEqual(['Status', 'failed', 'ok', 'ok']);
  });
});

describe('fetchCommand: many sources', () => {
  it('fetches at most four at once and lists them in config order', async () => {
    const sources: Source[] = Array.from({ length: 9 }, (_, index) => ({
      id: `feed-${index + 1}`,
      kind: 'rss',
      url: `https://example.com/feed-${index + 1}.xml`,
    }));
    const body = await fixture('feeds/rss2.xml');
    let inFlight = 0;
    let peak = 0;
    const slow = async (): Promise<Response> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return new Response(body, { headers: { 'content-type': 'application/rss+xml' } });
    };
    const h = await harness({ sources });

    const code = await fetchCommand({}, { ...h.deps, fetch: slow });

    expect(code).toBe(0);
    expect(peak).toBe(4);
    expect(tableRows(h.out()).map((row) => row[0])).toEqual([
      'Source',
      ...sources.map((source) => source.id),
    ]);
  });
});

describe('fetchCommand: --source', () => {
  it('fetches only the named sources, in config order', async () => {
    const h = await harness({ sources: [RSS, ATOM, REPO] });

    const code = await fetchCommand({ source: ['acme-widgets', 'example-feed'] }, h.deps);

    expect(code).toBe(0);
    expect(h.calls.map((call) => call.url).sort()).toEqual([REPO_ATOM_URL, RSS.url].sort());
    expect(tableRows(h.out()).map((row) => row[0])).toEqual([
      'Source',
      'example-feed',
      'acme-widgets',
    ]);
    expect(await allFiles(join(runFolder(), 'raw'))).toEqual([
      'acme-widgets.xml',
      'example-feed.xml',
    ]);
  });

  it('fetches a source named twice once', async () => {
    const h = await harness({ sources: [RSS, ATOM] });

    await fetchCommand({ source: ['example-feed', 'example-feed'] }, h.deps);

    expect(h.calls.filter((call) => call.url === RSS.url)).toHaveLength(1);
  });

  it('refuses an id that is not in the config, lists the known ones and fetches nothing', async () => {
    const h = await harness({ sources: [RSS, ATOM] });

    const code = await fetchCommand({ source: ['example-feed', 'nope', 'also-nope'] }, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toBe(
      'Unknown source: nope, also-nope. Sources in the config: example-feed, example-atom\n',
    );
    expect(h.calls).toEqual([]);
    await expect(readdir(outputRoot())).rejects.toThrow(/ENOENT/);
  });
});

describe('fetchCommand: the window', () => {
  it('uses the configured window by default', async () => {
    const h = await harness({ sources: [REPO], config: { windowDays: 1 } });

    await fetchCommand({}, h.deps);

    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.window.days).toBe(1);
    expect(summary.sources[0]?.items).toBe(1);
  });

  it('lets --since widen it, as `run --since` does', async () => {
    const h = await harness({ sources: [REPO] });

    await fetchCommand({ since: '30d' }, h.deps);

    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.window).toEqual({
      since: '2026-09-13T00:00:00.000Z',
      until: '2026-10-13T00:00:00.000Z',
      days: 30,
    });
    expect(summary.sources[0]?.items).toBe(5);
  });

  it.each(['week', '0d', '32d', '7', '-3d', '1.5d', ''])(
    'refuses --since "%s" before fetching anything',
    async (since) => {
      const h = await harness();

      const code = await fetchCommand({ since }, h.deps);

      expect(code).toBe(1);
      expect(h.err()).toContain(`Invalid --since "${since}"`);
      expect(h.calls).toEqual([]);
    },
  );

  it('caps each source at its own maxItems, or at maxItemsPerSource', async () => {
    const capped: Source = { ...RSS, maxItems: 1 };
    const h = await harness({
      sources: [capped, { ...ATOM, id: 'other-atom' }],
      config: { maxItemsPerSource: 2 },
    });

    await fetchCommand({}, h.deps);

    const summary = (await readJson(join(runFolder(), 'summary.json'))) as Summary;
    expect(summary.sources.map((source) => source.items)).toEqual([1, 2]);
    const items = (await readJson(join(runFolder(), 'items.json'))) as Item[];
    expect(items[0]?.title).toBe('Kubernetes 1.40 released');
  });
});

describe('fetchCommand: where it writes', () => {
  it('creates nothing under the data folder, not even the folder', async () => {
    const h = await harness({ sources: [RSS, ATOM] });

    await fetchCommand({}, h.deps);

    expect(await readdir(dir)).toEqual(['dist']);
  });

  it('leaves what is already in the data folder alone', async () => {
    await mkdir(join(dir, 'data', 'runs'), { recursive: true });
    await writeFile(join(dir, 'data', 'run.lock'), 'held');
    const h = await harness();

    await fetchCommand({}, h.deps);

    expect(await allFiles(join(dir, 'data'))).toEqual(['run.lock']);
    expect(await readFile(join(dir, 'data', 'run.lock'), 'utf8')).toBe('held');
  });

  it.each([
    ['the data folder itself', 'data'],
    ['a folder inside the data folder', 'data/fetch'],
    ['a folder inside it, spelled with ..', 'dist/../data/x'],
  ])('refuses --out %s', async (_name, out) => {
    const h = await harness();

    const code = await fetchCommand({ out }, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toContain('--out must not be inside the data folder');
    expect(h.calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('accepts a folder whose name only starts like the data folder', async () => {
    const h = await harness();

    const code = await fetchCommand({ out: 'data-fetch' }, h.deps);

    expect(code).toBe(0);
    expect(await readdir(join(dir, 'data-fetch'))).toEqual([STAMP]);
  });

  it('fails with the reason, before any request, when the output folder cannot be written', async () => {
    await writeFile(join(dir, 'taken'), 'a file, not a folder');
    const h = await harness();

    const code = await fetchCommand({ out: 'taken' }, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toMatch(/ENOTDIR|EEXIST/);
    expect(h.calls).toEqual([]);
  });

  it('never reuses a folder: a second run in the same instant stops before it fetches', async () => {
    await mkdir(runFolder(), { recursive: true });
    await writeFile(join(runFolder(), 'summary.json'), 'from an earlier run');
    const h = await harness();

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toBe(`${runFolder()} already exists; run the command again.\n`);
    expect(h.calls).toEqual([]);
    expect(await readFile(join(runFolder(), 'summary.json'), 'utf8')).toBe('from an earlier run');
  });
});

describe('fetchCommand: the GitHub token', () => {
  it('sends it to the API and never saves or prints it', async () => {
    const h = await harness({ sources: [REPO], secrets: { GITHUB_TOKEN: TOKEN } });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(0);
    expect(h.calls.map((call) => call.url)).toEqual([REPO_API_URL]);
    expect(h.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(await allFiles(runFolder())).toEqual([
      'items.json',
      'raw/acme-widgets.json',
      'summary.json',
    ]);
    await expectNoSecretAnywhere(h, TOKEN);
  });

  it('saves what the fetcher of a run returns with a token, item for item', async () => {
    const routes = await defaultRoutes();
    const h = await harness({ sources: [REPO], routes, secrets: { GITHUB_TOKEN: TOKEN } });
    const window = { since: new Date('2026-10-06T00:00:00Z'), until: new Date(NOW), maxItems: 20 };
    const run = createGithubReleasesFetcher({ fetch: serving(routes).fetch, token: TOKEN });

    await fetchCommand({}, h.deps);

    expect(await readJson(join(runFolder(), 'items.json'))).toEqual(await run.fetch(REPO, window));
  });

  it.each([
    ['the table cut', 70],
    ['the summary cut', 285],
  ])('is removed from an error text before %s, so no piece of it is left', async (_name, at) => {
    const message = `${'x'.repeat(at)}${TOKEN}`;
    const h = await harness({
      routes: { [RSS.url]: new Error(message) },
      secrets: { GITHUB_TOKEN: TOKEN },
    });

    await fetchCommand({}, h.deps);

    expect(h.out() + (await readFile(join(runFolder(), 'summary.json'), 'utf8'))).not.toContain(
      'ghp_',
    );
  });

  it("leaves a feed's own words alone when another secret is a common word", async () => {
    const h = await harness({ secrets: { SMTP_PASSWORD: 'Postgres' } });

    await fetchCommand({}, h.deps);

    expect(await readFile(join(runFolder(), 'raw', 'example-feed.xml'), 'utf8')).toBe(
      await fixture('feeds/rss2.xml'),
    );
    const items = (await readJson(join(runFolder(), 'items.json'))) as Item[];
    expect(items.map((item) => item.title)).toContain('Postgres 19 beta');
  });

  it('still removes that other secret from an error text', async () => {
    const routes = { [RSS.url]: new Error('login failed for hunter2') };
    const h = await harness({ routes, secrets: { SMTP_PASSWORD: 'hunter2' } });

    await fetchCommand({}, h.deps);

    expect(tableRows(h.out())[1]?.at(-1)).toBe('login failed for [redacted]');
    expect(await readFile(join(runFolder(), 'summary.json'), 'utf8')).not.toContain('hunter2');
  });

  it('reads the public feed, with no authorization, when there is no token', async () => {
    const h = await harness({ sources: [REPO] });

    await fetchCommand({}, h.deps);

    expect(h.calls.map((call) => call.url)).toEqual([REPO_ATOM_URL]);
    expect(h.calls[0]?.headers.has('authorization')).toBe(false);
  });

  it('keeps it out of an error that echoes it', async () => {
    const routes = { [REPO_API_URL]: new Error(`socket closed for Bearer ${TOKEN}`) };
    const h = await harness({ sources: [REPO], secrets: { GITHUB_TOKEN: TOKEN }, routes });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(h.out()).toContain('[redacted]');
    await expectNoSecretAnywhere(h, TOKEN);
  });

  it('keeps it out of a response body that echoes it', async () => {
    const body = JSON.stringify([{ message: `token ${TOKEN} is fine` }]);
    const routes = { [REPO_API_URL]: { body, type: 'application/json' } };
    const h = await harness({ sources: [REPO], secrets: { GITHUB_TOKEN: TOKEN }, routes });

    await fetchCommand({}, h.deps);

    const raw = await readFile(join(runFolder(), 'raw', 'acme-widgets.json'), 'utf8');
    expect(raw).toContain('[redacted]');
    await expectNoSecretAnywhere(h, TOKEN);
  });
});

async function expectNoSecretAnywhere(h: Harness, secret: string): Promise<void> {
  expect(h.out()).not.toContain(secret);
  expect(h.err()).not.toContain(secret);
  for (const file of await allFiles(h.dir)) {
    expect(await readFile(join(h.dir, file), 'utf8'), file).not.toContain(secret);
  }
}

describe('fetchCommand: configuration problems', () => {
  it('passes --config to the loader', async () => {
    const h = await harness();

    await fetchCommand({ config: 'mine.json' }, h.deps);

    expect(h.loadConfig).toHaveBeenCalledWith({ configPath: 'mine.json' });
  });

  it('prints why the config did not load and exits 1', async () => {
    const h = await harness();
    h.loadConfig.mockRejectedValueOnce(new DigestError('digest.config.json is not valid JSON'));

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toBe('digest.config.json is not valid JSON\n');
    expect(h.calls).toEqual([]);
  });
});
