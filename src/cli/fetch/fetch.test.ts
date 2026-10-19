import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGithubReleasesFetcher } from '../../sources/adapters/githubReleases';
import { createRssFetcher } from '../../sources/adapters/rss';
import { DigestError } from '../../shared/errors';
import type { Source } from '../../domain/schemas';
import { fetchCommand } from './fetch';
import {
  ATOM,
  DAY,
  NOW,
  REPO,
  REPO_ATOM_URL,
  RSS,
  allFiles,
  defaultRoutes,
  fixture,
  harness,
  pathsIn,
  readJson,
  savedItems,
  serving,
  sourceFiles,
  tableRows,
  useTempDir,
  type Harness,
  type HarnessOptions,
  type Summary,
} from './__fixtures__/fetchHarness';

const dir = useTempDir();
const setup = (options: HarnessOptions = {}): Promise<Harness> => harness(dir(), options);
const paths = (): ReturnType<typeof pathsIn> => pathsIn(dir());

describe('fetchCommand: what it saves', () => {
  it('writes each source to <out>/<day>/<source>/raw and formatted, and fetch-summary.json', async () => {
    const h = await setup({ sources: [RSS, REPO] });

    const code = await fetchCommand({ out: join(dir(), 'saved') }, h.deps);

    expect(code).toBe(0);
    expect(await allFiles(join(dir(), 'saved', DAY))).toEqual([
      ...sourceFiles('acme-widgets', 'xml'),
      ...sourceFiles('example-feed', 'xml'),
      'fetch-summary.json',
    ]);
  });

  it('saves a response body as the fetcher read it', async () => {
    const h = await setup();

    await fetchCommand({}, h.deps);

    expect(await readFile(paths().rawPath('example-feed', 'xml'), 'utf8')).toBe(
      await fixture('feeds/rss2.xml'),
    );
  });

  it("defaults the output folder to the config's data folder, in the day's folder", async () => {
    const h = await setup();

    await fetchCommand({}, h.deps);

    expect(await readdir(paths().outputRoot)).toEqual([DAY]);
  });

  it("puts each source's parsed items in its formatted/items.json", async () => {
    const h = await setup({ sources: [ATOM, RSS] });

    await fetchCommand({}, h.deps);

    const items = await savedItems(dir(), 'example-atom', 'example-feed');
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
    const h = await setup({ sources: [RSS, ATOM, REPO], routes });
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

    expect(await savedItems(dir(), 'example-feed', 'example-atom', 'acme-widgets')).toEqual(
      expected,
    );
  });

  it('describes the window and every source in fetch-summary.json', async () => {
    const h = await setup({ sources: [RSS, REPO] });

    await fetchCommand({}, h.deps);

    const summary = (await readJson(paths().summaryPath)) as Summary;
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
        raw: ['example-feed/raw/response-1.xml'],
        formatted: 'example-feed/formatted/items.json',
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
        raw: ['acme-widgets/raw/response-1.xml'],
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
    const h = await setup({ routes });

    await fetchCommand({}, h.deps);

    expect(await allFiles(join(paths().runFolder, 'example-feed', 'raw'))).toEqual([
      `response-1.${extension}`,
      'responses.json',
    ]);
    expect(await readFile(paths().rawPath('example-feed', extension), 'utf8')).toBe(body);
  });
});

describe('fetchCommand: the table and the exit code', () => {
  it('prints one row per source and exits 0 when every source worked', async () => {
    const h = await setup({ sources: [RSS, REPO] });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(0);
    expect(tableRows(h.out())).toEqual([
      ['Source', 'Status', 'HTTP', 'Items', 'Skipped', 'Time', 'Error'],
      ['example-feed', 'ok', '200', '2', '3', '0.0s'],
      ['acme-widgets', 'ok', '200', '3', '0', '0.0s'],
    ]);
  });

  it('ends with the totals and where the files are', async () => {
    const h = await setup({ sources: [RSS, REPO] });

    await fetchCommand({}, h.deps);

    expect(h.out()).toContain('2 sources: 2 ok, 0 failed, 5 items');
    expect(h.out()).toContain(`Saved to ${paths().runFolder}`);
  });

  it('shows how long each source took, from the clock', async () => {
    let calls = 0;
    const clock = { now: () => new Date(Date.parse(NOW) + 1_500 * calls++) };
    const h = await setup({ clock });

    await fetchCommand({}, h.deps);

    expect(tableRows(h.out())[1]?.at(-1)).toBe('1.5s');
    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.sources[0]?.durationMs).toBe(1_500);
  });

  it('exits 1 when a source answers with an error, names it, and still saves the others', async () => {
    const routes = { ...(await defaultRoutes()), [ATOM.url]: { status: 500, body: 'oops' } };
    const h = await setup({ sources: [RSS, ATOM], routes });

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
    expect(await allFiles(paths().runFolder)).toEqual([
      'example-atom/raw/response-1.html',
      'example-atom/raw/responses.json',
      ...sourceFiles('example-feed', 'xml'),
      'fetch-summary.json',
    ]);
    expect(await readFile(paths().rawPath('example-atom', 'html'), 'utf8')).toBe('oops');
    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.sources[1]).toEqual(
      expect.objectContaining({
        status: 'failed',
        httpStatus: 500,
        entries: null,
        skipped: null,
        items: 0,
        error: 'HTTP 500 fetching example-atom',
        raw: ['example-atom/raw/response-1.html'],
      }),
    );
  });

  it('keeps the body of a feed that cannot be parsed, to look at', async () => {
    const routes = { [RSS.url]: { body: '<rss><channel><item></channel>', type: 'text/xml' } };
    const h = await setup({ routes });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(await readFile(paths().rawPath('example-feed', 'xml'), 'utf8')).toBe(
      '<rss><channel><item></channel>',
    );
    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.sources[0]).toEqual(
      expect.objectContaining({ status: 'failed', httpStatus: 200 }),
    );
    expect(summary.sources[0]?.error).toMatch(/Cannot parse feed example-feed/);
  });

  it('reports a network failure without an HTTP status', async () => {
    const h = await setup({ routes: { [RSS.url]: new TypeError('fetch failed') } });

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
    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.sources[0]?.httpStatus).toBeNull();
  });

  it('gives a source that does not answer in time up and says so', async () => {
    const h = await setup({ routes: { [RSS.url]: 'hang' }, sourceTimeoutMs: 20 });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(tableRows(h.out())[1]?.at(-1)).toBe('Timed out after 20 ms');
  });

  it('shows a one-line, cut-down error in the table and the longer one in summary.json', async () => {
    const message = `bad\u001b[31m\u009b feed\u202Egnp\nsecond line ${'long '.repeat(200)}`;
    const h = await setup({ routes: { [RSS.url]: new Error(message) } });

    await fetchCommand({}, h.deps);

    const shown = tableRows(h.out())[1]?.at(-1) ?? '';
    expect(shown).toMatch(/^bad\[31m feedgnp second line long/);
    expect(shown.length).toBeLessThanOrEqual(80);
    for (const code of [0x1b, 0x9b, 0x202e]) {
      expect(h.out()).not.toContain(String.fromCharCode(code));
    }
    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.sources[0]?.error?.length).toBeLessThanOrEqual(300);
    expect(summary.sources[0]?.error?.length).toBeGreaterThan(80);
  });

  it('runs every source even when the first one fails', async () => {
    const routes = { ...(await defaultRoutes()), [RSS.url]: { status: 503 } };
    const h = await setup({ sources: [RSS, ATOM, REPO], routes });

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
    const h = await setup({ sources });

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
    const h = await setup({ sources: [RSS, ATOM, REPO] });

    const code = await fetchCommand({ source: ['acme-widgets', 'example-feed'] }, h.deps);

    expect(code).toBe(0);
    expect(h.calls.map((call) => call.url).sort()).toEqual([REPO_ATOM_URL, RSS.url].sort());
    expect(tableRows(h.out()).map((row) => row[0])).toEqual([
      'Source',
      'example-feed',
      'acme-widgets',
    ]);
    expect(await readdir(paths().runFolder)).toEqual([
      'acme-widgets',
      'example-feed',
      'fetch-summary.json',
    ]);
  });

  it('fetches a source named twice once', async () => {
    const h = await setup({ sources: [RSS, ATOM] });

    await fetchCommand({ source: ['example-feed', 'example-feed'] }, h.deps);

    expect(h.calls.filter((call) => call.url === RSS.url)).toHaveLength(1);
  });

  it('refuses an id that is not in the config, lists the known ones and fetches nothing', async () => {
    const h = await setup({ sources: [RSS, ATOM] });

    const code = await fetchCommand({ source: ['example-feed', 'nope', 'also-nope'] }, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toBe(
      'Unknown source: nope, also-nope. Sources in the config: example-feed, example-atom\n',
    );
    expect(h.calls).toEqual([]);
    await expect(readdir(paths().outputRoot)).rejects.toThrow(/ENOENT/);
  });
});

describe('fetchCommand: the window', () => {
  it('uses the configured window by default', async () => {
    const h = await setup({ sources: [REPO], config: { windowDays: 1 } });

    await fetchCommand({}, h.deps);

    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.window.days).toBe(1);
    expect(summary.sources[0]?.items).toBe(1);
  });

  it('lets --since widen it, as `run --since` does', async () => {
    const h = await setup({ sources: [REPO] });

    await fetchCommand({ since: '30d' }, h.deps);

    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.window).toEqual({
      since: '2026-09-13T00:00:00.000Z',
      until: '2026-10-13T00:00:00.000Z',
      days: 30,
    });
    expect(summary.sources[0]?.items).toBe(5);
  });

  it.each(['week', '0d', '32d', '7', '-3d', '1.5d', ''])(
    'refuses --since "%s" before loading the config or fetching anything',
    async (since) => {
      const h = await setup();

      const code = await fetchCommand({ since }, h.deps);

      expect(code).toBe(1);
      expect(h.err()).toContain(`Invalid --since "${since}"`);
      expect(h.loadConfig).not.toHaveBeenCalled();
      expect(h.calls).toEqual([]);
    },
  );

  it('caps each source at its own maxItems, or at maxItemsPerSource', async () => {
    const capped: Source = { ...RSS, maxItems: 1 };
    const h = await setup({
      sources: [capped, { ...ATOM, id: 'other-atom' }],
      config: { maxItemsPerSource: 2 },
    });

    await fetchCommand({}, h.deps);

    const summary = (await readJson(paths().summaryPath)) as Summary;
    expect(summary.sources.map((source) => source.items)).toEqual([1, 2]);
    const items = await savedItems(dir(), 'example-feed');
    expect(items.map((item) => item.title)).toEqual(['Kubernetes 1.40 released']);
  });
});

describe('fetchCommand: configuration problems', () => {
  it('passes --config to the loader', async () => {
    const h = await setup();

    await fetchCommand({ config: 'mine.json' }, h.deps);

    expect(h.loadConfig).toHaveBeenCalledWith({ configPath: 'mine.json' });
  });

  it('prints why the config did not load and exits 1', async () => {
    const h = await setup();
    h.loadConfig.mockRejectedValueOnce(new DigestError('digest.config.json is not valid JSON'));

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(h.err()).toBe('digest.config.json is not valid JSON\n');
    expect(h.calls).toEqual([]);
  });
});
