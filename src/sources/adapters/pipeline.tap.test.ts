import { describe, expect, it, vi } from 'vitest';
import type { Answer } from './http';
import type { RawEntry } from './entries/types';
import { createFetcher, type SourceAdapter, type SourceTap } from './pipeline';
import type { Source } from '../../domain/schemas';
import type { FetchWindow } from '../SourceFetcher';

// The debug tap of the source pipeline (W8-06): it sees what the feed request received and how
// the entries were read. It changes nothing, and nothing in a run passes one.

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const window: FetchWindow = {
  since: new Date('2026-10-05T00:00:00Z'),
  until: new Date('2026-10-13T00:00:00Z'),
  maxItems: 20,
};
const entry = (overrides: Partial<RawEntry> = {}): RawEntry => ({
  url: 'https://example.com/a',
  title: 'A title',
  text: 'Some text, long enough to need no page.',
  publishedAt: '2026-10-10T08:00:00Z',
  ...overrides,
});

const FEED_BODY = '<rss><channel/></rss>';

/** Serves the feed and, for any other url, a page; records every url asked for. */
function serving(pages: Record<string, string> = {}) {
  const asked: string[] = [];
  const fake = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    if (url === source.url) {
      return new Response(FEED_BODY, { headers: { 'content-type': 'application/rss+xml' } });
    }
    return new Response(pages[url] ?? '<html></html>', {
      headers: { 'content-type': 'text/html' },
    });
  });
  return { fetch: fake, asked };
}

/** An adapter that asks for the source url once and parses to the given entries. */
function adapterOf(
  entries: readonly RawEntry[],
  extra: Partial<SourceAdapter> = {},
): SourceAdapter {
  return {
    kind: 'rss',
    request: async (src, _window, get) => [await get(src.url)],
    parse: () => [...entries],
    ...extra,
  };
}

function recordingTap(): {
  tap: SourceTap;
  answers: (Answer & { sourceId: string })[];
  entries: { sourceId: string; parsed: number; skipped: number }[];
} {
  const answers: (Answer & { sourceId: string })[] = [];
  const entries: { sourceId: string; parsed: number; skipped: number }[] = [];
  return {
    tap: { answer: (event) => answers.push(event), entries: (event) => entries.push(event) },
    answers,
    entries,
  };
}

describe('createFetcher: tap', () => {
  it('reports the feed answer under the source id', async () => {
    const seen = recordingTap();
    const fetcher = createFetcher(adapterOf([entry()]), {
      fetch: serving().fetch,
      tap: seen.tap,
    });

    await fetcher.fetch(source, window);

    expect(seen.answers).toEqual([
      {
        sourceId: 'blog',
        url: source.url,
        status: 200,
        contentType: 'application/rss+xml',
        body: FEED_BODY,
      },
    ]);
  });

  it('reports one answer per request when an adapter makes several', async () => {
    const seen = recordingTap();
    const adapter = adapterOf([], {
      request: async (src, _window, get) => [await get(src.url), await get(src.url)],
    });

    await createFetcher(adapter, { fetch: serving().fetch, tap: seen.tap }).fetch(source, window);

    expect(seen.answers).toHaveLength(2);
  });

  it('counts the entries the adapter found and the ones that could not become items', async () => {
    const seen = recordingTap();
    const entries = [
      entry({ url: 'https://example.com/1' }),
      entry({ url: 'https://example.com/2' }),
      entry({ url: '' }),
      entry({ url: 'https://example.com/4', publishedAt: 'sometime' }),
      entry({ url: 'javascript:alert(1)' }),
    ];

    await createFetcher(adapterOf(entries), { fetch: serving().fetch, tap: seen.tap }).fetch(
      source,
      window,
    );

    expect(seen.entries).toEqual([{ sourceId: 'blog', parsed: 5, skipped: 3 }]);
  });

  it('does not count an entry outside the window or past the cap as skipped', async () => {
    const seen = recordingTap();
    const entries = [
      entry({ url: 'https://example.com/old', publishedAt: '2026-09-01T00:00:00Z' }),
      entry({ url: 'https://example.com/new-1', publishedAt: '2026-10-11T00:00:00Z' }),
      entry({ url: 'https://example.com/new-2', publishedAt: '2026-10-12T00:00:00Z' }),
    ];

    const items = await createFetcher(adapterOf(entries), {
      fetch: serving().fetch,
      tap: seen.tap,
    }).fetch(source, { ...window, maxItems: 1 });

    expect(items).toHaveLength(1);
    expect(seen.entries).toEqual([{ sourceId: 'blog', parsed: 3, skipped: 0 }]);
  });

  it('still reports the answer when the response cannot be parsed, and no entries', async () => {
    const seen = recordingTap();
    const adapter = adapterOf([], {
      parse: () => {
        throw new Error('Cannot parse feed blog');
      },
    });

    await expect(
      createFetcher(adapter, { fetch: serving().fetch, tap: seen.tap }).fetch(source, window),
    ).rejects.toThrow('Cannot parse feed blog');

    expect(seen.answers.map((a) => a.body)).toEqual([FEED_BODY]);
    expect(seen.entries).toEqual([]);
  });

  it('does not report the article pages fetched to fill in missing text', async () => {
    const seen = recordingTap();
    const served = serving({
      'https://example.com/a': '<article><p>The page text is long enough to be used.</p></article>',
    });
    const textless = entry({ text: '' });

    const items = await createFetcher(adapterOf([textless]), {
      fetch: served.fetch,
      tap: seen.tap,
    }).fetch(source, window);

    expect(served.asked).toContain('https://example.com/a');
    expect(items[0]?.summary).toContain('The page text');
    expect(seen.answers.map((a) => a.url)).toEqual([source.url]);
  });

  it('returns the same items with and without a tap', async () => {
    const entries = [entry(), entry({ url: 'https://example.com/b', title: 'B' })];
    const plain = await createFetcher(adapterOf(entries), { fetch: serving().fetch }).fetch(
      source,
      window,
    );

    const tapped = await createFetcher(adapterOf(entries), {
      fetch: serving().fetch,
      tap: recordingTap().tap,
    }).fetch(source, window);

    expect(tapped).toEqual(plain);
  });

  it('accepts a tap that listens to only one of the two events', async () => {
    const answer = vi.fn();
    const entries = vi.fn();

    await createFetcher(adapterOf([entry()]), {
      fetch: serving().fetch,
      tap: { answer },
    }).fetch(source, window);
    await createFetcher(adapterOf([entry()]), {
      fetch: serving().fetch,
      tap: { entries },
    }).fetch(source, window);

    expect(answer).toHaveBeenCalledTimes(1);
    expect(entries).toHaveBeenCalledTimes(1);
  });
});
