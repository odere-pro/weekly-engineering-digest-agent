import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORD_TIMEOUT_MS, recordSources, requestUrlFor } from '../../evals/recordSources.js';
import type { Source } from '../../src/core/schemas.js';
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
