import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchWindow } from '../../../sources/SourceFetcher';
import {
  ATOM,
  REPO,
  REPO_API_URL,
  REPO_ATOM_URL,
  RSS,
  TOKEN,
  defaultRoutes,
  serving,
} from '../__fixtures__/fetchHarness';
import { buildFetchers } from './buildFetchers';
import { createRecorder } from './recorder';

const WINDOW: FetchWindow = {
  since: new Date('2026-10-06T00:00:00Z'),
  until: new Date('2026-10-13T00:00:00Z'),
  maxItems: 20,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildFetchers', () => {
  it('reads an RSS or Atom source with the RSS fetcher', async () => {
    const served = serving(await defaultRoutes());
    const fetchers = buildFetchers({}, served.fetch, createRecorder());

    const rss = await fetchers.rss.fetch(RSS, WINDOW);
    const atom = await fetchers.rss.fetch(ATOM, WINDOW);

    expect(rss.map((item) => item.sourceId)).toEqual(['example-feed', 'example-feed']);
    expect(atom.map((item) => item.sourceId)).toEqual(['example-atom', 'example-atom']);
    expect(served.calls.map((call) => call.url)).toEqual([RSS.url, ATOM.url]);
  });

  it("gives the recorder the source's answers and its entry count", async () => {
    const served = serving(await defaultRoutes());
    const recorder = createRecorder();

    await buildFetchers({}, served.fetch, recorder).rss.fetch(RSS, WINDOW);

    const [answer] = recorder.answers(RSS.id);
    expect(answer).toEqual(
      expect.objectContaining({ sourceId: RSS.id, url: RSS.url, status: 200 }),
    );
    expect(recorder.entries(RSS.id)).toEqual({ sourceId: RSS.id, parsed: 7, skipped: 3 });
  });

  it('reads the public Atom feed of a repository when there is no token', async () => {
    const served = serving(await defaultRoutes());

    await buildFetchers({}, served.fetch, createRecorder()).github.fetch(REPO, WINDOW);

    expect(served.calls.map((call) => call.url)).toEqual([REPO_ATOM_URL]);
    expect(served.calls[0]?.headers.has('authorization')).toBe(false);
  });

  it('reads the REST API with the token when there is one', async () => {
    const served = serving(await defaultRoutes());
    const fetchers = buildFetchers({ GITHUB_TOKEN: TOKEN }, served.fetch, createRecorder());

    const items = await fetchers.github.fetch(REPO, WINDOW);

    expect(items.length).toBeGreaterThan(0);
    expect(served.calls.map((call) => call.url)).toEqual([REPO_API_URL]);
    expect(served.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each(['', '   '])('treats the token %j as no token', async (blank) => {
    const served = serving(await defaultRoutes());

    await buildFetchers({ GITHUB_TOKEN: blank }, served.fetch, createRecorder()).github.fetch(
      REPO,
      WINDOW,
    );

    expect(served.calls.map((call) => call.url)).toEqual([REPO_ATOM_URL]);
  });

  it('uses the given fetch for every request, never the global one', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the global fetch was used');
    });
    const served = serving({});

    await expect(
      buildFetchers({}, served.fetch, createRecorder()).rss.fetch(RSS, WINDOW),
    ).rejects.toThrow(/404/);

    expect(served.calls.map((call) => call.url)).toEqual([RSS.url]);
  });
});
