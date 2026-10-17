import { readFileSync } from 'node:fs';
import { extractFromXml } from '@extractus/feed-extractor';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRssFetcher } from '../../../src/adapters/sources/rss.js';
import { ItemSchema, type Item, type Source } from '../../../src/core/schemas.js';
import type { FetchWindow } from '../../../src/ports/SourceFetcher.js';
import { FetchError } from '../../../src/shared/errors.js';
import { noopLogger } from '../../../src/shared/telemetry.js';
import { toPlainText } from '../../../src/shared/text.js';
import { itemIdFor, normalizeUrl } from '../../../src/shared/url.js';

// Delegates to the real parser unless a test overrides it, so the defensive paths for
// shapes the library never emits (missing fields, non-Error throws) can be exercised.
vi.mock('@extractus/feed-extractor', async (importOriginal) => {
  const actual = await importOriginal<{ extractFromXml: typeof extractFromXml }>();
  return { ...actual, extractFromXml: vi.fn(actual.extractFromXml) };
});

// Same idea for the text helper: real unless a test makes one entry blow up.
vi.mock('../../../src/shared/text.js', async (importOriginal) => {
  const actual = await importOriginal<{ toPlainText: typeof toPlainText }>();
  return { ...actual, toPlainText: vi.fn(actual.toPlainText) };
});

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/feeds/${name}`, import.meta.url), 'utf8');
const sourcesFixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/sources/${name}`, import.meta.url), 'utf8');

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

  describe('entries that share one link', () => {
    const SHARED = 'https://docs.cloud.google.com/release-notes';
    const gcp = source({
      id: 'gcp-release-notes',
      url: 'https://docs.cloud.google.com/feeds/gcp-release-notes.xml',
    });
    const wide = window({
      since: new Date('2026-10-01T00:00:00Z'),
      until: new Date('2026-10-13T00:00:00Z'),
    });
    const fetchGcp = (fetchWindow: FetchWindow) =>
      createRssFetcher({ fetch: respond(sourcesFixture('gcp-release-notes.xml')) }).fetch(
        gcp,
        fetchWindow,
      );

    it('keeps every entry of a feed whose entries all link to one page', async () => {
      const items = await fetchGcp(wide);

      expect(items.map((item) => item.title)).toEqual([
        'October 12, 2026',
        'October 08, 2026',
        'October 07, 2026',
      ]);
      expect(new Set(items.map((item) => item.id)).size).toBe(3);
      expect(new Set(items.map((item) => item.url)).size).toBe(3);
    });

    it('builds each url from the shared link plus the entry id, and the id from that url', async () => {
      const items = await fetchGcp(wide);

      for (const item of items) {
        const url = new URL(item.url);
        expect(`${url.origin}${url.pathname}`).toBe(SHARED);
        expect(url.searchParams.get('entry')).toMatch(
          /^tag:google\.com,2016:gcp-release-notes#October_\d{2}_2026$/,
        );
        expect(item.id).toBe(itemIdFor(item.url));
        expect(() => ItemSchema.parse(item)).not.toThrow();
      }
    });

    it('survives the link check and dedupe rules, which compare normalized urls', async () => {
      const items = await fetchGcp(wide);

      expect(new Set(items.map((item) => normalizeUrl(item.url))).size).toBe(3);
    });

    it('gives an entry the same url whatever the window, so a later week sees the same item', async () => {
      const onlyTheLastDay = window({
        since: new Date('2026-10-12T00:00:00Z'),
        until: new Date('2026-10-13T00:00:00Z'),
      });

      const [narrow] = await fetchGcp(onlyTheLastDay);
      const all = await fetchGcp(wide);

      expect(narrow?.title).toBe('October 12, 2026');
      expect(narrow?.url).toContain('entry=');
      expect(narrow).toEqual(all.find((item) => item.title === 'October 12, 2026'));
    });

    it('drops the fragment of a shared link like any other link, and adds the entry id', async () => {
      const entry = (id: string, section: string, date: string) =>
        `<entry><id>${id}</id><title>${section}</title><updated>${date}</updated>` +
        `<link rel="alternate" href="https://example.com/notes#${section}"/></entry>`;
      const body =
        '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>' +
        entry('urn:a', 'A', '2026-10-12T09:00:00Z') +
        entry('urn:b', 'B', '2026-10-11T09:00:00Z') +
        '</feed>';

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items.map((item) => item.url)).toEqual([
        'https://example.com/notes?entry=urn%3Aa',
        'https://example.com/notes?entry=urn%3Ab',
      ]);
      expect(new Set(items.map((item) => item.id)).size).toBe(2);
    });

    it('keeps the query of a shared link byte for byte and adds the entry id after it', async () => {
      const entry = (id: string, date: string) =>
        `<entry><id>${id}</id><title>${id}</title><updated>${date}</updated>` +
        '<link rel="alternate" href="https://example.com/notes?q=a%20b+c&amp;page=2"/></entry>';
      const body =
        '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>' +
        entry('one', '2026-10-12T09:00:00Z') +
        entry('two', '2026-10-11T09:00:00Z') +
        '</feed>';

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items.map((item) => item.url)).toEqual([
        'https://example.com/notes?q=a%20b+c&page=2&entry=one',
        'https://example.com/notes?q=a%20b+c&page=2&entry=two',
      ]);
    });

    it('gives only the entries that share a link an entry id', async () => {
      const entry = (id: string, href: string, date: string) =>
        `<entry><id>${id}</id><title>${id}</title><updated>${date}</updated>` +
        `<link rel="alternate" href="${href}"/></entry>`;
      const body =
        '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>' +
        entry('shared-1', 'https://example.com/notes', '2026-10-12T09:00:00Z') +
        entry('unique', 'https://example.com/unique', '2026-10-11T09:00:00Z') +
        entry('shared-2', 'https://example.com/notes', '2026-10-10T09:00:00Z') +
        '</feed>';

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items.map((item) => item.url)).toEqual([
        'https://example.com/notes?entry=shared-1',
        'https://example.com/unique',
        'https://example.com/notes?entry=shared-2',
      ]);
    });

    it('treats links that differ only by tracking parameters as shared', async () => {
      const item = (title: string, utm: string, guid: string, date: string) =>
        rssItem({ title, link: `https://example.com/p?utm_source=${utm}`, date }).replace(
          '<item>',
          `<item><guid>${guid}</guid>`,
        );
      const body = rssWith(
        item('One', 'a', 'g1', 'Mon, 12 Oct 2026 09:00:00 GMT') +
          item('Two', 'b', 'g2', 'Sun, 11 Oct 2026 09:00:00 GMT'),
      );

      const items = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(items).toHaveLength(2);
      expect(new Set(items.map((entry) => entry.id)).size).toBe(2);
    });

    it('leaves the links of a feed whose entries all differ exactly as they are', async () => {
      const items = await createRssFetcher({ fetch: respond(fixture('rss2.xml')) }).fetch(
        source(),
        window(),
      );

      expect(items.map((item) => item.url)).toEqual([
        'https://example.com/posts/k8s-1-40',
        'https://example.com/posts/postgres-19',
      ]);
    });
  });

  describe('entries that cannot be used', () => {
    const SKIPPED = 'Skipped feed entries that could not be read';
    const NONE_USABLE = 'No feed entry had a usable link and date';
    const badThenGood = rssWith(
      rssItem({
        title: 'Bad',
        link: 'https://example.com/bad',
        date: 'Mon, 12 Oct 2026 09:00:00 GMT',
      }) +
        rssItem({
          title: 'Good',
          link: 'https://example.com/good',
          date: 'Sun, 11 Oct 2026 09:00:00 GMT',
        }),
    );

    function failOnce(thrown: unknown = new RangeError('Invalid code point 1114112')): void {
      vi.mocked(toPlainText).mockImplementationOnce(() => {
        throw thrown;
      });
    }

    const loggerWithWarn = () => {
      const warn = vi.fn();
      return { warn, logger: { ...noopLogger, warn } };
    };

    it('skips an entry that cannot be converted, keeps the others and logs once for the feed', async () => {
      failOnce();
      const { warn, logger } = loggerWithWarn();

      const items = await createRssFetcher({ fetch: respond(badThenGood), logger }).fetch(
        source({ id: 'bad-feed' }),
        window(),
      );

      expect(items.map((item) => item.title)).toEqual(['Good']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(SKIPPED, {
        sourceId: 'bad-feed',
        failed: 1,
        of: 2,
        firstError: 'Invalid code point 1114112',
      });
    });

    it('logs one line however many entries fail', async () => {
      const failing = vi.mocked(toPlainText);
      failing.mockImplementationOnce(() => {
        throw new Error('first');
      });
      failing.mockImplementationOnce(() => {
        throw new Error('second');
      });
      const { warn, logger } = loggerWithWarn();

      const items = await createRssFetcher({ fetch: respond(badThenGood), logger }).fetch(
        source(),
        window(),
      );

      expect(items).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        SKIPPED,
        expect.objectContaining({ failed: 2, of: 2, firstError: 'first' }),
      );
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('caps the logged error text', async () => {
      failOnce(new Error('x'.repeat(5000)));
      const { warn, logger } = loggerWithWarn();

      await createRssFetcher({ fetch: respond(badThenGood), logger }).fetch(source(), window());

      const fields = warn.mock.calls[0]?.[1] as { firstError: string };
      expect(fields.firstError.length).toBeLessThanOrEqual(300);
    });

    it('skips it quietly when no logger is given', async () => {
      failOnce();

      const items = await createRssFetcher({ fetch: respond(badThenGood) }).fetch(
        source(),
        window(),
      );

      expect(items.map((item) => item.title)).toEqual(['Good']);
    });

    it('names a non-Error throw too', async () => {
      failOnce('plain string failure');
      const { warn, logger } = loggerWithWarn();

      await createRssFetcher({ fetch: respond(badThenGood), logger }).fetch(source(), window());

      expect(warn).toHaveBeenCalledWith(
        SKIPPED,
        expect.objectContaining({ firstError: 'plain string failure' }),
      );
    });

    it('warns when a feed has entries and none has a usable link and date', async () => {
      const body = rssWith(
        rssItem({ title: 'No date', link: 'https://example.com/a' }) +
          rssItem({ title: 'Bad date', link: 'https://example.com/b', date: 'sometime' }),
      );
      const { warn, logger } = loggerWithWarn();

      const items = await createRssFetcher({ fetch: respond(body), logger }).fetch(
        source({ id: 'dateless-feed' }),
        window(),
      );

      expect(items).toEqual([]);
      expect(warn).toHaveBeenCalledWith(NONE_USABLE, { sourceId: 'dateless-feed', entries: 2 });
    });

    it('stays quiet for an empty feed, a feed with one usable entry, and entries outside the window', async () => {
      const outside = rssWith(
        rssItem({ link: 'https://example.com/old', date: 'Mon, 01 Jun 2026 09:00:00 GMT' }),
      );
      const { warn, logger } = loggerWithWarn();

      for (const body of [rssWith(''), fixture('rss2.xml'), outside]) {
        await createRssFetcher({ fetch: respond(body), logger }).fetch(source(), window());
      }

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('redirects and size', () => {
    const moved = (location: string, status = 301): Response =>
      new Response(null, { status, headers: { location } });

    function scripted(...replies: Response[]) {
      let next = 0;
      return vi.fn<typeof fetch>(async () => replies[next++] ?? new Response('', { status: 500 }));
    }

    it('follows a redirect to the same host and handles redirects itself', async () => {
      const fetchMock = scripted(
        moved('https://example.com/new/feed.xml'),
        new Response(fixture('rss2.xml')),
      );

      const items = await createRssFetcher({ fetch: fetchMock }).fetch(source(), window());

      expect(items).toHaveLength(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'https://example.com/feed.xml',
        'https://example.com/new/feed.xml',
      ]);
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
    });

    it.each([
      ['https://example.com/feed.xml', 'https://www.example.com/feed.xml'],
      ['https://www.example.com/feed.xml', 'https://example.com/feed.xml'],
    ])('follows a redirect from %s to %s', async (from, to) => {
      const fetchMock = scripted(moved(to), new Response(fixture('rss2.xml')));

      const items = await createRssFetcher({ fetch: fetchMock }).fetch(
        source({ url: from }),
        window(),
      );

      expect(items).toHaveLength(2);
    });

    it('fails the source on a redirect to another host, and does not request that host', async () => {
      const fetchMock = scripted(moved('https://evil.example.org/feed.xml'), new Response('x'));

      const error = await createRssFetcher({ fetch: fetchMock })
        .fetch(source({ id: 'example-feed' }), window())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ retryable: false });
      expect((error as Error).message).toContain('example-feed');
      expect((error as Error).message).toContain('evil.example.org');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails a feed that is larger than 5 MiB', async () => {
      const huge = new Response('<rss/>', {
        headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
      });

      const error = await createRssFetcher({ fetch: scripted(huge) })
        .fetch(source({ id: 'huge-feed' }), window())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect((error as Error).message).toMatch(/huge-feed.*5 MiB/);
    });

    it.each(['ftp://example.com/feed.xml', 'file:///etc/passwd'])(
      'refuses a source url that is not http(s): %s',
      async (url) => {
        const fetchMock = scripted(new Response('x'));

        const error = await createRssFetcher({ fetch: fetchMock })
          .fetch(source({ url }), window())
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(FetchError);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('typed failures', () => {
    it.each([
      [408, true],
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [403, false],
      [404, false],
      [410, false],
    ])('HTTP %i is a FetchError with that status, retryable: %s', async (status, retryable) => {
      const error = await createRssFetcher({ fetch: respond('nope', status) })
        .fetch(source({ id: 'flaky-feed' }), window())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({
        status,
        retryable,
        message: `HTTP ${String(status)} fetching flaky-feed`,
      });
    });

    it('a feed that does not parse is a FetchError no retry can fix', async () => {
      const error = await createRssFetcher({ fetch: respond(fixture('malformed.xml')) })
        .fetch(source({ id: 'broken-feed' }), window())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FetchError);
      expect(error).toMatchObject({ retryable: false });
      expect((error as FetchError).status).toBeUndefined();
    });
  });

  describe('field choices', () => {
    const originalTz = process.env.TZ;
    const feedWindow = window({
      since: new Date('2026-10-01T00:00:00Z'),
      until: new Date('2026-10-13T00:00:00Z'),
    });

    // A zone far from UTC, so a date read in local time cannot pass by luck.
    beforeAll(() => {
      process.env.TZ = 'America/Los_Angeles';
    });

    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    const itemsOf = (name: string) =>
      createRssFetcher({ fetch: respond(sourcesFixture(name)) }).fetch(source(), feedWindow);
    const byTitle = (items: Item[], title: string) => items.find((item) => item.title === title);

    it('prefers the alternate link over the first link', async () => {
      const items = await itemsOf('atom-links-and-dates.xml');

      expect(byTitle(items, 'Post with several links')?.url).toBe(
        'https://example.org/blog/post-1',
      );
    });

    it('cleans an alternate link: no tracking parameters, no fragment, no raw space', async () => {
      const body =
        '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>' +
        '<entry><id>e</id><title>Tracked</title><updated>2026-10-12T09:00:00Z</updated>' +
        '<link rel="alternate" href="https://example.com/a b?utm_source=rss&amp;id=7&amp;fbclid=XYZ#top"/>' +
        '</entry></feed>';

      const [item] = await createRssFetcher({ fetch: respond(body) }).fetch(source(), window());

      expect(item?.url).toBe('https://example.com/a%20b?id=7');
    });

    it('reads a link without rel as the alternate', async () => {
      const items = await itemsOf('atom-links-and-dates.xml');

      expect(byTitle(items, 'Post with a zone-less date')?.url).toBe(
        'https://example.org/blog/post-2',
      );
    });

    it('keeps the first link when none is an alternate', async () => {
      const items = await itemsOf('atom-links-and-dates.xml');

      expect(byTitle(items, 'Post whose only link is not an alternate')?.url).toBe(
        'https://example.org/blog/atom/post-3.xml',
      );
    });

    it('prefers published over updated', async () => {
      const items = await itemsOf('atom-links-and-dates.xml');

      expect(byTitle(items, 'Post with several links')?.publishedAt).toBe(
        '2026-10-08T10:00:00.000Z',
      );
    });

    it('uses updated when an Atom entry has no published', async () => {
      const items = await itemsOf('atom-links-and-dates.xml');

      expect(byTitle(items, 'Post whose only link is not an alternate')?.publishedAt).toBe(
        '2026-10-10T09:00:00.000Z',
      );
    });

    it('reads a date without a zone as UTC', async () => {
      const atom = await itemsOf('atom-links-and-dates.xml');
      const rss = await itemsOf('rss-html-summaries.xml');

      expect(byTitle(atom, 'Post with a zone-less date')?.publishedAt).toBe(
        '2026-10-09T08:30:00.000Z',
      );
      expect(byTitle(rss, 'Rust generics land')?.publishedAt).toBe('2026-10-10T09:00:00.000Z');
      expect(byTitle(rss, 'Post with only full content')?.publishedAt).toBe(
        '2026-10-08T07:00:00.000Z',
      );
    });

    it('keeps script text out of the summary', async () => {
      const items = await itemsOf('rss-html-summaries.xml');

      const summary = byTitle(items, 'Post with an inline script')?.summary;

      expect(summary).toBe('Visible text. More text.');
      expect(summary).not.toContain('secret-marker');
    });

    it('keeps generics like Vec<T> in the summary', async () => {
      const items = await itemsOf('rss-html-summaries.xml');

      expect(byTitle(items, 'Rust generics land')?.summary).toBe(
        'Use Vec<T> and Option<U> for owned lists.',
      );
    });

    it('falls back to the full content when an RSS item has no description', async () => {
      const items = await itemsOf('rss-html-summaries.xml');

      expect(byTitle(items, 'Post with only full content')?.summary).toBe('Full body text');
    });
  });
});
