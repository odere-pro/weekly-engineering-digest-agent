import { readFileSync } from 'node:fs';
import type { extractFromXml } from '@extractus/feed-extractor';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRssFetcher } from './rss';
import { ItemSchema, type Item, type Source } from '../../domain/schemas';
import type { FetchWindow } from '../SourceFetcher';
import { noopLogger } from '../../shared/telemetry';
import { toPlainText } from '../../shared/text';
import { itemIdFor, normalizeUrl } from '../../shared/url';

// Delegates to the real parser unless a test overrides it, so the defensive paths for
// shapes the library never emits (missing fields, non-Error throws) can be exercised.
vi.mock('@extractus/feed-extractor', async (importOriginal) => {
  const actual = await importOriginal<{ extractFromXml: typeof extractFromXml }>();
  return { ...actual, extractFromXml: vi.fn(actual.extractFromXml) };
});

// Same idea for the text helper: real unless a test makes one entry blow up.
vi.mock('../../shared/text', async (importOriginal) => {
  const actual = await importOriginal<{ toPlainText: typeof toPlainText }>();
  return { ...actual, toPlainText: vi.fn(actual.toPlainText) };
});

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/feeds/${name}`, import.meta.url), 'utf8');
const sourcesFixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/sources/${name}`, import.meta.url), 'utf8');

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
