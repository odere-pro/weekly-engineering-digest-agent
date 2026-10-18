import { describe, expect, it, vi } from 'vitest';
import type { Reply } from './http';
import { createFetcher, normalizeEntry, type RawEntry, type SourceAdapter } from './pipeline';
import { ItemSchema, type Source } from '../../domain/schemas';
import type { FetchWindow } from '../SourceFetcher';
import { noopLogger } from '../../shared/telemetry';
import { itemIdFor } from '../../shared/url';

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const window = (overrides: Partial<FetchWindow> = {}): FetchWindow => ({
  since: new Date('2026-10-05T00:00:00Z'),
  until: new Date('2026-10-13T00:00:00Z'),
  maxItems: 20,
  ...overrides,
});
const raw = (overrides: Partial<RawEntry> = {}): RawEntry => ({
  url: 'https://example.com/a',
  title: ' A title ',
  text: '<p>Some <b>text</b> &amp; more</p>',
  publishedAt: '2026-10-10T08:00:00Z',
  ...overrides,
});
const options = { maxSummaryChars: 600 };

describe('normalizeEntry', () => {
  it('builds the item: id from the url, plain summary, trimmed title, ISO date', () => {
    expect(normalizeEntry(raw(), source, options)).toEqual({
      id: itemIdFor('https://example.com/a'),
      sourceId: 'blog',
      kind: 'rss',
      url: 'https://example.com/a',
      title: 'A title',
      summary: 'Some text & more',
      publishedAt: '2026-10-10T08:00:00.000Z',
    });
  });

  it('truncates the summary to maxSummaryChars', () => {
    const item = normalizeEntry(raw({ text: 'word '.repeat(100) }), source, {
      maxSummaryChars: 50,
    });
    expect(item?.summary.length).toBeLessThanOrEqual(50);
    expect(item?.summary.endsWith('...')).toBe(true);
  });

  it.each([
    ['an empty url', { url: '' }],
    ['a relative url', { url: '/posts/a' }],
    ['a javascript url', { url: 'javascript:alert(1)' }],
    ['an ftp url', { url: 'ftp://example.com/a' }],
    ['an unparseable date', { publishedAt: 'sometime' }],
    ['an invalid Date', { publishedAt: new Date('nope') }],
  ])('drops an entry with %s', (_name, overrides) => {
    expect(normalizeEntry(raw(overrides), source, options)).toBeUndefined();
  });

  it('reads a date without a zone as UTC and accepts a Date', () => {
    expect(
      normalizeEntry(raw({ publishedAt: '2026-10-10 08:00' }), source, options)?.publishedAt,
    ).toBe('2026-10-10T08:00:00.000Z');
    expect(
      normalizeEntry(raw({ publishedAt: new Date('2026-10-10T09:00:00Z') }), source, options)
        ?.publishedAt,
    ).toBe('2026-10-10T09:00:00.000Z');
  });

  it('appends the entry id as ?entry= only when the link is shared', () => {
    const entry = raw({ url: 'https://example.com/notes?x=1', entryId: 'id 1' });

    expect(normalizeEntry(entry, source, options)?.url).toBe('https://example.com/notes?x=1');
    const distinct = normalizeEntry(entry, source, { ...options, distinctLink: true });
    expect(distinct?.url).toBe('https://example.com/notes?x=1&entry=id%201');
    expect(distinct?.id).toBe(itemIdFor(distinct?.url ?? ''));
  });

  it('keeps the link when a shared-link entry has no entry id', () => {
    const item = normalizeEntry(raw(), source, { ...options, distinctLink: true });
    expect(item?.url).toBe('https://example.com/a');
  });
});

const ok = (body = ''): Reply => ({ ok: true, status: 200, headers: new Headers(), body });

function adapterOf(
  entries: readonly RawEntry[],
  extra: Partial<SourceAdapter> = {},
): SourceAdapter {
  return {
    kind: 'rss',
    request: async () => [ok()],
    parse: () => [...entries],
    ...extra,
  };
}

const pageFetch = (pages: Record<string, string> = {}) =>
  vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response(pages[url] ?? '<html></html>', {
      headers: { 'content-type': 'text/html' },
    });
  });

describe('createFetcher', () => {
  it('reports the adapter kind', () => {
    expect(createFetcher(adapterOf([]), { fetch: pageFetch() }).kind).toBe('rss');
  });

  it('returns valid items in the window, newest first, capped', async () => {
    const entries = [
      raw({ url: 'https://example.com/1', publishedAt: '2026-10-06T00:00:00Z' }),
      raw({ url: 'https://example.com/2', publishedAt: '2026-10-12T00:00:00Z' }),
      raw({ url: 'https://example.com/3', publishedAt: '2026-10-09T00:00:00Z' }),
      raw({ url: 'https://example.com/old', publishedAt: '2026-09-01T00:00:00Z' }),
      raw({ url: 'https://example.com/future', publishedAt: '2026-11-01T00:00:00Z' }),
    ];
    const fetcher = createFetcher(adapterOf(entries), { fetch: pageFetch() });

    const items = await fetcher.fetch(source, window({ maxItems: 2 }));

    expect(items.map((i) => i.url)).toEqual(['https://example.com/2', 'https://example.com/3']);
    for (const item of items) expect(ItemSchema.safeParse(item).success).toBe(true);
  });

  it('flattens the entries of several replies', async () => {
    const adapter = adapterOf([], {
      request: async () => [ok('one'), ok('two')],
      parse: (reply) => [raw({ url: `https://example.com/${reply.body}` })],
    });
    const items = await createFetcher(adapter, { fetch: pageFetch() }).fetch(source, window());
    expect(items.map((i) => i.url).sort()).toEqual([
      'https://example.com/one',
      'https://example.com/two',
    ]);
  });

  it('skips one entry that cannot be converted, keeps the rest and warns once', async () => {
    const warn = vi.fn();
    const entries = [
      raw({ url: 'https://example.com/bad', text: 'x' }),
      raw({ url: 'https://example.com/good', text: 'y' }),
    ];
    const adapter = adapterOf(entries);
    const poisoned = {
      ...entries[0],
      get title(): string {
        throw new RangeError('bad entry');
      },
    } as RawEntry;

    const items = await createFetcher(adapterOf([poisoned, entries[1] as RawEntry]), {
      fetch: pageFetch(),
      logger: { ...noopLogger, warn },
    }).fetch({ ...source, id: 'blog' }, window());

    expect(adapter.kind).toBe('rss');
    expect(items.map((i) => i.url)).toEqual(['https://example.com/good']);
    expect(warn).toHaveBeenCalledWith('Skipped feed entries that could not be read', {
      sourceId: 'blog',
      failed: 1,
      of: 2,
      firstError: 'bad entry',
    });
  });

  it('warns when entries exist and none is usable', async () => {
    const warn = vi.fn();
    const adapter = adapterOf([raw({ publishedAt: 'sometime' })]);
    const items = await createFetcher(adapter, {
      fetch: pageFetch(),
      logger: { ...noopLogger, warn },
    }).fetch(source, window());
    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledWith('No feed entry had a usable link and date', {
      sourceId: 'blog',
      entries: 1,
    });
  });

  it('gives entries that share a link their entry id, and leaves distinct links alone', async () => {
    const entries = [
      raw({ url: 'https://example.com/notes', entryId: 'a', publishedAt: '2026-10-10T00:00:00Z' }),
      raw({ url: 'https://example.com/notes', entryId: 'b', publishedAt: '2026-10-09T00:00:00Z' }),
      raw({ url: 'https://example.com/solo', entryId: 'c', publishedAt: '2026-10-08T00:00:00Z' }),
    ];
    const items = await createFetcher(adapterOf(entries), { fetch: pageFetch() }).fetch(
      source,
      window(),
    );

    expect(items.map((i) => i.url)).toEqual([
      'https://example.com/notes?entry=a',
      'https://example.com/notes?entry=b',
      'https://example.com/solo',
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });

  it('drops an item that fails the schema', async () => {
    const adapter = adapterOf([raw({ url: 'https://example.com/ok' }), raw({ url: 'http://' })]);
    const items = await createFetcher(adapter, { fetch: pageFetch() }).fetch(source, window());
    expect(items.map((i) => i.url)).toEqual(['https://example.com/ok']);
  });

  it('propagates a failing request', async () => {
    const adapter = adapterOf([], {
      request: async () => {
        throw new Error('HTTP 500 fetching blog');
      },
    });
    await expect(
      createFetcher(adapter, { fetch: pageFetch() }).fetch(source, window()),
    ).rejects.toThrow('HTTP 500 fetching blog');
  });

  it('passes the request the source, the window and a get that follows the feed host only', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('', { status: 302, headers: { location: 'https://evil.example.org/' } }),
    );
    const adapter = adapterOf([], {
      request: async (_s, _w, get) => [await get('https://example.com/feed.xml')],
    });
    await expect(
      createFetcher(adapter, { fetch: fetchImpl }).fetch(source, window()),
    ).rejects.toThrow(/not its own host/);
  });

  it('lets an adapter name extra redirect hosts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: 'https://api.example.net/x' } }),
      )
      .mockResolvedValueOnce(new Response('payload'));
    const adapter = adapterOf([], {
      redirectHosts: ['api.example.net'],
      request: async (_s, _w, get) => [await get('https://example.com/feed.xml')],
      parse: (reply) => [raw({ title: reply.body })],
    });
    const items = await createFetcher(adapter, { fetch: fetchImpl }).fetch(source, window());
    expect(items[0]?.title).toBe('payload');
  });

  describe('enrichment', () => {
    const empty = (path: string, date: string): RawEntry =>
      raw({ url: `https://example.com/${path}`, text: '', publishedAt: date });
    const pages = {
      'https://example.com/new':
        '<html><head><meta name="description" content="Fetched from the page."></head></html>',
      'https://example.com/mid':
        '<html><head><meta name="description" content="Middle page."></head></html>',
    };

    it('fills an empty summary from the entry page', async () => {
      const fetchImpl = pageFetch(pages);
      const items = await createFetcher(adapterOf([empty('new', '2026-10-12T00:00:00Z')]), {
        fetch: fetchImpl,
      }).fetch(source, window());

      expect(items[0]?.summary).toBe('Fetched from the page.');
    });

    it('does not fetch a page for an entry that has text', async () => {
      const fetchImpl = pageFetch(pages);
      await createFetcher(adapterOf([raw({ url: 'https://example.com/new' })]), {
        fetch: fetchImpl,
      }).fetch(source, window());
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('fetches pages only for entries that survive the window and the cap', async () => {
      const entries = [
        empty('new', '2026-10-12T00:00:00Z'),
        empty('mid', '2026-10-11T00:00:00Z'),
        empty('old', '2026-10-06T00:00:00Z'),
        empty('outside', '2026-08-01T00:00:00Z'),
      ];
      const fetchImpl = pageFetch(pages);

      await createFetcher(adapterOf(entries), { fetch: fetchImpl }).fetch(
        source,
        window({ maxItems: 2 }),
      );

      expect(fetchImpl.mock.calls.map(([url]) => url as string).sort()).toEqual([
        'https://example.com/mid',
        'https://example.com/new',
      ]);
    });

    describe('redirect to another host', () => {
      const redirecting = (to: string, pages: Record<string, string>) =>
        vi.fn<typeof fetch>(async (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url === 'https://example.com/new') {
            return new Response(null, { status: 301, headers: { location: to } });
          }
          return new Response(pages[url] ?? '<html></html>', {
            headers: { 'content-type': 'text/html' },
          });
        });
      const target = 'https://blog.example.net/post';
      const targetPages = {
        [target]:
          '<html><head><meta name="description" content="From the new host."></head></html>',
      };
      const run = (collectionHosts: readonly string[] | undefined, fetchImpl: typeof fetch) =>
        createFetcher(adapterOf([empty('new', '2026-10-12T00:00:00Z')]), {
          fetch: fetchImpl,
          ...(collectionHosts ? { collectionHosts } : {}),
        }).fetch(source, window());

      it('is followed when the target host is in the collection allowlist', async () => {
        const items = await run(['blog.example.net'], redirecting(target, targetPages));
        expect(items[0]?.summary).toBe('From the new host.');
      });

      it('is refused for a host outside the allowlist, leaving the summary empty', async () => {
        const fetchImpl = redirecting(target, targetPages);
        const items = await run(['other.example.org'], fetchImpl);
        expect(items[0]?.summary).toBe('');
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://example.com/new']);
      });

      it('is refused to an allowlisted host over plain http', async () => {
        const items = await run(
          ['blog.example.net'],
          redirecting('http://blog.example.net/post', {}),
        );
        expect(items[0]?.summary).toBe('');
      });

      it('is refused to another port of an allowlisted host', async () => {
        const items = await run(
          ['blog.example.net'],
          redirecting('https://blog.example.net:8443/post', {}),
        );
        expect(items[0]?.summary).toBe('');
      });
    });

    it('is off with enrich: false', async () => {
      const fetchImpl = pageFetch(pages);
      const items = await createFetcher(adapterOf([empty('new', '2026-10-12T00:00:00Z')]), {
        fetch: fetchImpl,
        enrich: false,
      }).fetch(source, window());
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(items[0]?.summary).toBe('');
    });

    it('is off for an adapter that opts out', async () => {
      const fetchImpl = pageFetch(pages);
      await createFetcher(
        adapterOf([empty('new', '2026-10-12T00:00:00Z')], { enrichable: false }),
        {
          fetch: fetchImpl,
        },
      ).fetch(source, window());
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('keeps the item with an empty summary when its page fails', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
      const items = await createFetcher(adapterOf([empty('new', '2026-10-12T00:00:00Z')]), {
        fetch: fetchImpl,
      }).fetch(source, window());
      expect(items).toHaveLength(1);
      expect(items[0]?.summary).toBe('');
    });

    it('keeps the distinct link of an enriched entry', async () => {
      const entries = [
        { ...empty('notes', '2026-10-12T00:00:00Z'), entryId: 'a' },
        { ...empty('notes', '2026-10-11T00:00:00Z'), entryId: 'b' },
      ];
      const items = await createFetcher(adapterOf(entries), { fetch: pageFetch() }).fetch(
        source,
        window(),
      );
      expect(items.map((i) => i.url)).toEqual([
        'https://example.com/notes?entry=a',
        'https://example.com/notes?entry=b',
      ]);
    });
  });
});
