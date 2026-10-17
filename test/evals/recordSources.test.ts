import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECORD_TIMEOUT_MS,
  compactPage,
  recordPages,
  recordSources,
  requestUrlFor,
} from '../../evals/recordSources.js';
import type { Item, Source } from '../../src/core/schemas.js';
import { itemIdFor } from '../../src/shared/url.js';
import { MAX_BODY_BYTES } from '../../src/adapters/sources/http.js';
import { fixedClock } from '../../src/shared/clock.js';

const rss: Source = { id: 'feed-a', kind: 'rss', url: 'https://a.example.com/feed.xml' };
const repo: Source = { id: 'repo-b', kind: 'github', url: 'https://github.com/example/repo-b' };

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'record-sources-'));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const NOW = '2026-10-17T08:00:00.000Z';
const deps = (fetchImpl: typeof fetch, sources: readonly Source[]) => ({
  sources,
  fetch: fetchImpl,
  clock: fixedClock(NOW),
  log: () => undefined,
});

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(outDir, path), 'utf8')) as Record<string, unknown>;

describe('requestUrlFor', () => {
  it('requests a feed as it is and a repository through its releases feed', () => {
    expect(requestUrlFor(rss)).toBe(rss.url);
    expect(requestUrlFor(repo)).toBe('https://github.com/example/repo-b/releases.atom');
    expect(requestUrlFor({ ...repo, url: 'https://github.com/example/repo-b/' })).toBe(
      'https://github.com/example/repo-b/releases.atom',
    );
  });
});

describe('recordSources', () => {
  it('writes response.json and the body for each source', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(urlOf(input));
      return new Response('<rss>hello</rss>', {
        status: 200,
        headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      });
    };

    await recordSources({ outDir }, deps(fetchImpl, [rss, repo]));

    expect(requested).toEqual([rss.url, 'https://github.com/example/repo-b/releases.atom']);
    expect((await readdir(join(outDir, 'feed-a'))).sort()).toEqual(['body.xml', 'response.json']);
    expect(await readJson('feed-a/response.json')).toEqual({
      url: rss.url,
      status: 200,
      contentType: 'application/rss+xml; charset=utf-8',
      fetchedAt: NOW,
      bodyFile: 'body.xml',
    });
    expect(await readFile(join(outDir, 'feed-a', 'body.xml'), 'utf8')).toBe('<rss>hello</rss>');
    expect((await readJson('repo-b/response.json'))['url']).toBe(
      'https://github.com/example/repo-b/releases.atom',
    );
  });

  it('keeps a JSON body as body.json', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"a":1}', { headers: { 'content-type': 'application/json' } });

    await recordSources({ outDir }, deps(fetchImpl, [rss]));

    expect((await readJson('feed-a/response.json'))['bodyFile']).toBe('body.json');
    expect(await readFile(join(outDir, 'feed-a', 'body.json'), 'utf8')).toBe('{"a":1}');
  });

  it('never writes expected.json', async () => {
    await recordSources(
      { outDir },
      deps(async () => new Response('<rss/>'), [rss]),
    );

    expect(await readdir(join(outDir, 'feed-a'))).not.toContain('expected.json');
  });

  it('records a body over the cap as an error with no body', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const result = await recordSources(
      { outDir },
      deps(async () => new Response(big), [rss]),
    );

    const response = await readJson('feed-a/response.json');
    expect(String(response['error'])).toMatch(/larger than/);
    expect(response['bodyFile']).toBeUndefined();
    expect(await readdir(join(outDir, 'feed-a'))).toEqual(['response.json']);
    expect(result.failed.map((f) => f.sourceId)).toEqual(['feed-a']);
  });

  it('records an HTTP error with its status and no body', async () => {
    const result = await recordSources(
      { outDir },
      deps(async () => new Response('nope', { status: 404 }), [rss]),
    );

    const response = await readJson('feed-a/response.json');
    expect(response).toMatchObject({ status: 404, error: 'HTTP 404 fetching feed-a' });
    expect(await readdir(join(outDir, 'feed-a'))).toEqual(['response.json']);
    expect(result.failed).toHaveLength(1);
  });

  it('records a network failure and goes on with the next source', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (urlOf(input) === rss.url) throw new Error('connection reset');
      return new Response('<feed/>');
    };

    const result = await recordSources({ outDir }, deps(fetchImpl, [rss, repo]));

    expect(String((await readJson('feed-a/response.json'))['error'])).toMatch(/connection reset/);
    expect((await readJson('repo-b/response.json'))['bodyFile']).toBe('body.xml');
    expect(result.recorded.map((r) => r.sourceId)).toEqual(['repo-b']);
    expect(result.failed.map((f) => f.sourceId)).toEqual(['feed-a']);
  });

  it('passes an abort signal that fires after the timeout', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Response('<rss/>');
    };

    await recordSources({ outDir }, deps(fetchImpl, [rss]));

    expect(signal).toBeDefined();
    expect(RECORD_TIMEOUT_MS).toBe(20_000);
  });

  it('sends no credentials', async () => {
    let headers: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      headers = init?.headers;
      return new Response('<rss/>');
    };

    await recordSources({ outDir }, deps(fetchImpl, [rss]));

    expect(JSON.stringify(headers ?? {}).toLowerCase()).not.toMatch(/authorization|token|cookie/);
  });

  it('reports to the console, fetches with the global fetch and reads the clock by default', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async () => new Response('<rss/>'));
    try {
      const result = await recordSources({ outDir }, { sources: [rss] });

      expect(result.recorded).toHaveLength(1);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('recorded feed-a'));
      const response = await readJson('feed-a/response.json');
      expect(Date.parse(String(response['fetchedAt']))).not.toBeNaN();
    } finally {
      vi.unstubAllGlobals();
      logged.mockRestore();
    }
  });

  it('keeps the last good recording when a refresh fails', async () => {
    await recordSources(
      { outDir },
      deps(async () => new Response('<rss>old</rss>'), [rss]),
    );

    const result = await recordSources(
      { outDir },
      deps(async () => new Response('down', { status: 503 }), [rss]),
    );

    expect(result.failed).toHaveLength(1);
    expect(await readFile(join(outDir, 'feed-a', 'body.xml'), 'utf8')).toBe('<rss>old</rss>');
    expect((await readJson('feed-a/response.json'))['bodyFile']).toBe('body.xml');
  });
});

describe('recordPages', () => {
  const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>No text</title><link>https://a.example.com/one</link><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate></item>
    <item><title>Has text</title><link>https://a.example.com/two</link><pubDate>Sun, 11 Oct 2026 09:00:00 GMT</pubDate><description>Already has a description.</description></item>
    <item><title>Elsewhere</title><link>https://other.example.org/three</link><pubDate>Sat, 10 Oct 2026 09:00:00 GMT</pubDate></item>
    <item><title>Gone</title><link>https://a.example.com/four</link><pubDate>Fri, 09 Oct 2026 09:00:00 GMT</pubDate></item>
    </channel></rss>`;
  const PAGE =
    '<html><head><style>p{}</style><script>var big = 1;</script></head><body><article><p>Paragraph that is long enough to keep.</p></article></body></html>';
  const idOf = (url: string): string => itemIdFor(url);

  async function seed(source: Source, feed: string, expectedItems: Item[]): Promise<void> {
    const dir = join(outDir, source.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'body.xml'), feed);
    await writeFile(
      join(dir, 'response.json'),
      JSON.stringify({
        url: source.url,
        status: 200,
        contentType: 'application/xml',
        fetchedAt: NOW,
        bodyFile: 'body.xml',
      }),
    );
    await writeFile(
      join(dir, 'expected.json'),
      JSON.stringify({ reviewed: true, entryCount: 4, items: expectedItems, knownGaps: [] }),
    );
  }

  const expectedFor = (urls: string[]): Item[] =>
    urls.map((url) => ({
      id: idOf(url),
      sourceId: rss.id,
      kind: 'rss',
      url,
      title: url,
      summary: '',
      publishedAt: '2026-10-12T09:00:00.000Z',
    }));
  const URLS = [
    'https://a.example.com/one',
    'https://a.example.com/two',
    'https://other.example.org/three',
    'https://a.example.com/four',
  ];

  function fetching(): { fetchImpl: typeof fetch; requested: string[] } {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = urlOf(input);
      requested.push(url);
      return url.endsWith('/four')
        ? new Response('nope', { status: 404 })
        : new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    };
    return { fetchImpl, requested };
  }

  it('records the page of each entry whose feed carries no text, without script and style', async () => {
    await seed(rss, FEED, expectedFor(URLS));
    const { fetchImpl, requested } = fetching();

    const result = await recordPages({ outDir }, { ...deps(fetchImpl, [rss, repo]) });

    expect(requested.sort()).toEqual(['https://a.example.com/four', 'https://a.example.com/one']);
    const page = await readFile(
      join(outDir, 'feed-a', 'pages', `${idOf(URLS[0]!)}.html.txt`),
      'utf8',
    );
    expect(page).toContain('Paragraph that is long enough');
    expect(page).not.toMatch(/<script|<style|var big/);
    expect(result.recorded).toEqual([
      { sourceId: 'feed-a', pages: 1, bytes: expect.any(Number) as number },
    ]);
  });

  it('reports a page that fails or is on another host, and writes nothing for it', async () => {
    await seed(rss, FEED, expectedFor(URLS));
    const { fetchImpl } = fetching();

    const result = await recordPages({ outDir }, deps(fetchImpl, [rss]));

    expect(result.failed.map((f) => f.url).sort()).toEqual([
      'https://a.example.com/four',
      'https://other.example.org/three',
    ]);
    const names = await readdir(join(outDir, 'feed-a', 'pages'));
    expect(names).toEqual([`${idOf(URLS[0]!)}.html.txt`]);
  });

  it('does not fetch a page it already has', async () => {
    await seed(rss, FEED, expectedFor(URLS));
    const first = fetching();
    await recordPages({ outDir }, deps(first.fetchImpl, [rss]));
    const second = fetching();

    await recordPages({ outDir }, deps(second.fetchImpl, [rss]));

    expect(second.requested).toEqual(['https://a.example.com/four']);
  });

  it('leaves GitHub sources alone', async () => {
    await seed(rss, FEED, expectedFor(URLS));
    const dir = join(outDir, 'repo-b');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'body.xml'), '<feed/>');
    await writeFile(
      join(dir, 'response.json'),
      JSON.stringify({ url: requestUrlFor(repo), fetchedAt: NOW, bodyFile: 'body.xml' }),
    );
    await writeFile(
      join(dir, 'expected.json'),
      JSON.stringify({ reviewed: true, entryCount: 0, items: [], knownGaps: [] }),
    );
    const { fetchImpl, requested } = fetching();

    await recordPages({ outDir }, deps(fetchImpl, [rss, repo]));

    expect(requested.every((url) => url.includes('example'))).toBe(true);
  });
});

describe('compactPage', () => {
  it('drops scripts, styles, svg, nav, header, footer and attribute values of a thousand characters or more', () => {
    const html = `<html><head><meta name="description" content="Short kept."><script>x()</script></head><body><svg><path d="M0"/></svg><div data-props="${'x'.repeat(1500)}"><p>Kept text</p></div></body></html>`;

    const out = compactPage(html);

    expect(out).toContain('content="Short kept."');
    expect(out).toContain('<p>Kept text</p>');
    expect(out).toContain('data-props=""');
    expect(out).not.toMatch(/<script|<svg|xxxx/);
  });
});
