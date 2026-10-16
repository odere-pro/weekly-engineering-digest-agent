import { readFileSync } from 'node:fs';
import { extractFromXml } from '@extractus/feed-extractor';
import { describe, expect, it, vi } from 'vitest';
import { createRssFetcher } from '../../../src/adapters/sources/rss.js';
import { ItemSchema, type Source } from '../../../src/core/schemas.js';
import type { FetchWindow } from '../../../src/ports/SourceFetcher.js';
import { itemIdFor } from '../../../src/shared/url.js';

// Delegates to the real parser unless a test overrides it, so the defensive paths for
// shapes the library never emits (missing fields, non-Error throws) can be exercised.
vi.mock('@extractus/feed-extractor', async (importOriginal) => {
  const actual = await importOriginal<{ extractFromXml: typeof extractFromXml }>();
  return { ...actual, extractFromXml: vi.fn(actual.extractFromXml) };
});

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/feeds/${name}`, import.meta.url), 'utf8');

const window = (overrides: Partial<FetchWindow> = {}): FetchWindow => ({
  since: new Date('2026-10-05T00:00:00Z'),
  until: new Date('2026-10-13T00:00:00Z'),
  maxItems: 20,
  ...overrides,
});

const source = (overrides: Partial<Source> = {}): Source => ({
  id: 'example-feed',
  kind: 'rss',
  url: 'https://example.com/feed.xml',
  ...overrides,
});

const respond = (body: string, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(body, { status }));

const rssWith = (items: string): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;

const rssItem = (fields: { title?: string; link?: string; date?: string; description?: string }) =>
  `<item><title>${fields.title ?? 'T'}</title>${fields.link === undefined ? '' : `<link>${fields.link}</link>`}${
    fields.date === undefined ? '' : `<pubDate>${fields.date}</pubDate>`
  }<description>${fields.description ?? 'D'}</description></item>`;

describe('createRssFetcher', () => {
  it('reports kind rss', () => {
    expect(createRssFetcher().kind).toBe('rss');
  });

  describe('parsing', () => {
    it('parses an RSS 2.0 fixture into valid items, newest first', async () => {
      const fetcher = createRssFetcher({ fetch: respond(fixture('rss2.xml')) });

      const items = await fetcher.fetch(source(), window());

      expect(items.map((item) => item.title)).toEqual([
        'Kubernetes 1.40 released',
        'Postgres 19 beta',
      ]);
      for (const item of items) {
        expect(() => ItemSchema.parse(item)).not.toThrow();
        expect(item.sourceId).toBe('example-feed');
        expect(item.kind).toBe('rss');
        expect(item.id).toBe(itemIdFor(item.url));
      }
      expect(items[0]?.url).toBe('https://example.com/posts/k8s-1-40');
      expect(items[0]?.publishedAt).toBe('2026-10-12T09:00:00.000Z');
      expect(items[1]?.publishedAt).toBe('2026-10-10T10:30:00.000Z');
    });

    it('parses an Atom fixture into valid items, newest first', async () => {
      const fetcher = createRssFetcher({ fetch: respond(fixture('atom.xml')) });

      const items = await fetcher.fetch(source({ id: 'example-releases' }), window());

      expect(items.map((item) => item.title)).toEqual(['Terraform 2.0', 'Go 1.27']);
      for (const item of items) {
        expect(() => ItemSchema.parse(item)).not.toThrow();
        expect(item.sourceId).toBe('example-releases');
      }
      expect(items[0]?.url).toBe('https://example.org/releases/terraform-2-0');
      expect(items[1]?.summary).toBe('Go 1.27 adds new iterators.');
    });

    it('makes one GET of the source url', async () => {
      const fetchMock = respond(fixture('rss2.xml'));

      await createRssFetcher({ fetch: fetchMock }).fetch(source(), window());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.com/feed.xml');
    });

    it('falls back to global fetch when none is injected', async () => {
      const globalFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(fixture('rss2.xml')));

      const items = await createRssFetcher().fetch(source(), window());

      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(items).toHaveLength(2);
    });
  });

  describe('filtering', () => {
    it('drops entries outside the window, undated and invalid-date entries, and entries without a link', async () => {
      const fetcher = createRssFetcher({ fetch: respond(fixture('rss2.xml')) });

      const items = await fetcher.fetch(source(), window());

      const titles = items.map((item) => item.title);
      expect(titles).not.toContain('Old announcement');
      expect(titles).not.toContain('Future announcement');
      expect(titles).not.toContain('Undated post');
      expect(titles).not.toContain('Bad date post');
      expect(titles).not.toContain('No link post');
      expect(items).toHaveLength(2);
    });

    it('keeps entries exactly on the window bounds', async () => {
      const body = rssWith(
        rssItem({
          title: 'At since',
          link: 'https://example.com/a',
          date: 'Mon, 05 Oct 2026 00:00:00 GMT',
        }) +
          rssItem({
            title: 'At until',
            link: 'https://example.com/b',
            date: 'Tue, 13 Oct 2026 00:00:00 GMT',
          }),
      );

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items.map((item) => item.title)).toEqual(['At until', 'At since']);
    });

    it('drops entries whose link is not an absolute url', async () => {
      const body = rssWith(
        rssItem({
          title: 'Relative',
          link: '/posts/relative',
          date: 'Mon, 12 Oct 2026 09:00:00 GMT',
        }) +
          rssItem({
            title: 'Absolute',
            link: 'https://example.com/ok',
            date: 'Mon, 12 Oct 2026 08:00:00 GMT',
          }),
      );

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items.map((item) => item.title)).toEqual(['Absolute']);
    });

    it.each([
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'ftp://example.com/x',
    ])('drops an entry whose link uses a non-http(s) scheme: %s', async (link) => {
      const body = rssWith(
        rssItem({ title: 'Bad scheme', link, date: 'Mon, 12 Oct 2026 09:00:00 GMT' }) +
          rssItem({
            title: 'Good',
            link: 'https://example.com/ok',
            date: 'Mon, 12 Oct 2026 08:00:00 GMT',
          }),
      );

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items.map((item) => item.title)).toEqual(['Good']);
    });

    it('returns an empty list for a feed with no entries', async () => {
      const items = await createRssFetcher({ fetch: respond(rssWith('')) }).fetch(
        source(),
        window(),
      );

      expect(items).toEqual([]);
    });

    it('keeps the newest maxItems', async () => {
      const fetcher = createRssFetcher({ fetch: respond(fixture('rss2.xml')) });

      const items = await fetcher.fetch(source(), window({ maxItems: 1 }));

      expect(items.map((item) => item.title)).toEqual(['Kubernetes 1.40 released']);
    });

    it('applies maxItems after sorting, so an oldest-first feed keeps its newest entries', async () => {
      const body = rssWith(
        rssItem({
          title: 'Oldest',
          link: 'https://example.com/1',
          date: 'Sat, 10 Oct 2026 09:00:00 GMT',
        }) +
          rssItem({
            title: 'Middle',
            link: 'https://example.com/2',
            date: 'Sun, 11 Oct 2026 09:00:00 GMT',
          }) +
          rssItem({
            title: 'Newest',
            link: 'https://example.com/3',
            date: 'Mon, 12 Oct 2026 09:00:00 GMT',
          }),
      );

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(
        source(),
        window({ maxItems: 2 }),
      );

      expect(items.map((item) => item.title)).toEqual(['Newest', 'Middle']);
    });

    it('sorts newest first even when the feed lists oldest first', async () => {
      const body = rssWith(
        rssItem({
          title: 'Older',
          link: 'https://example.com/1',
          date: 'Sat, 10 Oct 2026 09:00:00 GMT',
        }) +
          rssItem({
            title: 'Newer',
            link: 'https://example.com/2',
            date: 'Mon, 12 Oct 2026 09:00:00 GMT',
          }),
      );

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items.map((item) => item.title)).toEqual(['Newer', 'Older']);
    });
  });

  describe('summary', () => {
    it('strips HTML and decodes entities', async () => {
      const fetcher = createRssFetcher({ fetch: respond(fixture('rss2.xml')) });

      const [first] = await fetcher.fetch(source(), window());

      expect(first?.summary).toBe('Kubernetes 1.40 brings sidecar improvements & faster rollouts.');
    });

    it('truncates the summary to maxSummaryChars', async () => {
      const fetcher = createRssFetcher({
        fetch: respond(fixture('rss2.xml')),
        maxSummaryChars: 30,
      });

      const [first] = await fetcher.fetch(source(), window());

      expect(first?.summary.length).toBeLessThanOrEqual(30);
      expect(first?.summary.endsWith('...')).toBe(true);
    });

    it('caps summaries at 600 characters by default, not at the library default', async () => {
      const longText = 'word '.repeat(400);
      const body = rssWith(
        rssItem({
          link: 'https://example.com/long',
          date: 'Mon, 12 Oct 2026 09:00:00 GMT',
          description: longText,
        }),
      );

      const [item] = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(item?.summary.length).toBeGreaterThan(300);
      expect(item?.summary.length).toBeLessThanOrEqual(600);
      expect(item?.summary.endsWith('...')).toBe(true);
    });

    it('uses empty strings for an entry with no title and no description', async () => {
      const body = rssWith(
        '<item><link>https://example.com/bare</link><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate></item>',
      );

      const [item] = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(item).toMatchObject({ url: 'https://example.com/bare', title: '', summary: '' });
      expect(() => ItemSchema.parse(item)).not.toThrow();
    });

    it('leaves a short summary untouched', async () => {
      const [, second] = await createRssFetcher({ fetch: respond(fixture('rss2.xml')) }).fetch(
        source(),
        window(),
      );

      expect(second?.summary).toBe('Beta one is out.');
    });
  });

  describe('errors', () => {
    it('throws on a non-2xx response, naming the source', async () => {
      const fetcher = createRssFetcher({ fetch: respond('boom', 500) });

      await expect(fetcher.fetch(source({ id: 'flaky-feed' }), window())).rejects.toThrow(
        'HTTP 500 fetching flaky-feed',
      );
    });

    it('throws on malformed XML, naming the source', async () => {
      const fetcher = createRssFetcher({ fetch: respond(fixture('malformed.xml')) });

      await expect(fetcher.fetch(source({ id: 'broken-feed' }), window())).rejects.toThrow(
        /broken-feed/,
      );
    });

    it('throws when the body is not a feed, naming the source', async () => {
      const fetcher = createRssFetcher({ fetch: respond('<html><body>hi</body></html>') });

      await expect(fetcher.fetch(source({ id: 'html-page' }), window())).rejects.toThrow(
        /html-page/,
      );
    });

    it('propagates network failures from fetch unchanged', async () => {
      const failure = new TypeError('fetch failed');
      const fetcher = createRssFetcher({ fetch: vi.fn<typeof fetch>().mockRejectedValue(failure) });

      await expect(fetcher.fetch(source(), window())).rejects.toBe(failure);
    });
  });

  describe('defensive handling of unexpected parser output', () => {
    const bareEntry = { id: 'e' };

    it('treats a feed without an entries list as empty', async () => {
      vi.mocked(extractFromXml).mockReturnValueOnce({ title: 'No entries' });

      const items = await createRssFetcher({ fetch: respond('<x/>') }).fetch(source(), window());

      expect(items).toEqual([]);
    });

    it('drops entries whose link or date fields are missing entirely', async () => {
      vi.mocked(extractFromXml).mockReturnValueOnce({
        entries: [
          { ...bareEntry, published: '2026-10-12T09:00:00.000Z' },
          { ...bareEntry, link: 'https://example.com/no-date' },
        ],
      });

      const items = await createRssFetcher({ fetch: respond('<x/>') }).fetch(source(), window());

      expect(items).toEqual([]);
    });

    it('drops an entry whose link is not an absolute url', async () => {
      vi.mocked(extractFromXml).mockReturnValueOnce({
        entries: [{ ...bareEntry, link: '/posts/relative', published: '2026-10-12T09:00:00.000Z' }],
      });

      const items = await createRssFetcher({ fetch: respond('<x/>') }).fetch(source(), window());

      expect(items).toEqual([]);
    });

    it('falls back to empty title and summary when the parser omits them', async () => {
      vi.mocked(extractFromXml).mockReturnValueOnce({
        entries: [
          { ...bareEntry, link: 'https://example.com/bare', published: '2026-10-12T09:00:00.000Z' },
        ],
      });

      const [item] = await createRssFetcher({ fetch: respond('<x/>') }).fetch(source(), window());

      expect(item).toMatchObject({ title: '', summary: '' });
    });

    it('keeps the original error as cause when the parser throws', async () => {
      const failure = new Error('The XML document is not well-formed');
      vi.mocked(extractFromXml).mockImplementationOnce(() => {
        throw failure;
      });

      const result = createRssFetcher({ fetch: respond('<x/>') }).fetch(
        source({ id: 'cause-feed' }),
        window(),
      );

      await expect(result).rejects.toMatchObject({
        message: expect.stringContaining('cause-feed') as string,
        cause: failure,
      });
    });

    it('names the source even when the parser throws a non-Error value', async () => {
      vi.mocked(extractFromXml).mockImplementationOnce(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point: a non-Error throw
        throw 'plain string failure';
      });

      await expect(
        createRssFetcher({ fetch: respond('<x/>') }).fetch(source({ id: 'odd-feed' }), window()),
      ).rejects.toThrow(/odd-feed.*plain string failure/);
    });
  });

  describe('abort signal', () => {
    it('passes the abort signal to fetch', async () => {
      const fetchMock = respond(fixture('rss2.xml'));
      const controller = new AbortController();

      await createRssFetcher({ fetch: fetchMock }).fetch(source(), window(), controller.signal);

      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    });
  });
});
