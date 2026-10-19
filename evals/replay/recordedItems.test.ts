import { describe, expect, it } from 'vitest';
import type { Source } from '../../src/domain/schemas';
import { makeItem } from '../../test/builders';
import { WEEK_40 } from '../evalKit';
import { endOfWeek, newestFirst, recordedFetchers, servedIds, sourcesOf } from './recordedItems';

const window = { since: new Date(0), until: new Date(), maxItems: 20 };
const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T09:00:00Z`;

describe('newestFirst', () => {
  it('sorts by publication time, newest first, without changing the input', () => {
    const old = makeItem({ publishedAt: at(1) });
    const recent = makeItem({ publishedAt: at(5) });
    const input = [old, recent];

    expect(newestFirst(input)).toEqual([recent, old]);
    expect(input).toEqual([old, recent]);
  });

  it('keeps file order for items published at the same time', () => {
    const first = makeItem({ publishedAt: at(1) });
    const second = makeItem({ publishedAt: at(1) });

    expect(newestFirst([first, second])).toEqual([first, second]);
  });
});

describe('servedIds', () => {
  const items = (sourceId: string, count: number) =>
    Array.from({ length: count }, (_, i) => makeItem({ sourceId, publishedAt: at(i + 1) }));
  const source = (id: string, maxItems?: number): Source => ({
    id,
    kind: 'rss',
    url: `https://${id}.example/feed`,
    ...(maxItems === undefined ? {} : { maxItems }),
  });

  it("serves a source's newest items up to its own maxItems", () => {
    const own = items('a', 5);

    const served = servedIds(own, [source('a', 2)], 20);

    expect([...served]).toEqual([own[4]!.id, own[3]!.id]);
  });

  it('falls back to the config-wide cap for a source with no maxItems or no entry', () => {
    const a = items('a', 4);
    const b = items('b', 4);

    const served = servedIds([...a, ...b], [source('a')], 3);

    expect(served.size).toBe(6);
    expect(served.has(a[0]!.id)).toBe(false);
    expect(served.has(b[0]!.id)).toBe(false);
  });

  it('is empty for no items', () => {
    expect(servedIds([], [], 20).size).toBe(0);
  });
});

describe('endOfWeek', () => {
  it('is the last millisecond of the ISO week, UTC', () => {
    expect(endOfWeek(WEEK_40).toISOString()).toBe('2026-10-04T23:59:59.999Z');
  });
});

describe('sourcesOf', () => {
  it('makes one source per source id found in the items', () => {
    const a1 = makeItem({ sourceId: 'a', kind: 'rss', url: 'https://a.example/1' });
    const a2 = makeItem({ sourceId: 'a', kind: 'rss', url: 'https://a.example/2' });
    const b1 = makeItem({ sourceId: 'b', kind: 'github', url: 'https://b.example/1' });

    const sources = sourcesOf([a1, a2, b1], []);

    expect(sources.map((s) => s.id)).toEqual(['a', 'b']);
    expect(sources.map((s) => s.kind)).toEqual(['rss', 'github']);
    expect(sources.every((s) => s.maxItems === undefined)).toBe(true);
  });

  it('keeps the maxItems the allowlist gives a source and leaves the others without one', () => {
    const a = makeItem({ sourceId: 'a' });
    const b = makeItem({ sourceId: 'b' });
    const allowlist: Source[] = [{ id: 'a', kind: 'rss', url: 'https://a.example/', maxItems: 7 }];

    const sources = sourcesOf([a, b], allowlist);

    expect(sources.find((s) => s.id === 'a')?.maxItems).toBe(7);
    expect(sources.find((s) => s.id === 'b')).not.toHaveProperty('maxItems');
  });
});

describe('recordedFetchers', () => {
  const source: Source = { id: 'a', kind: 'rss', url: 'https://a.example/feed' };

  it('has a fetcher for every source kind', () => {
    const fetchers = recordedFetchers([]);

    expect(Object.keys(fetchers).sort()).toEqual(['github', 'rss']);
  });

  it("serves the source's own items, newest first, at most the window's maxItems", async () => {
    const items = [
      makeItem({ sourceId: 'a', publishedAt: at(1) }),
      makeItem({ sourceId: 'a', publishedAt: at(3) }),
      makeItem({ sourceId: 'a', publishedAt: at(2) }),
      makeItem({ sourceId: 'other', publishedAt: at(9) }),
    ];

    const served = await recordedFetchers(items).rss!.fetch(source, { ...window, maxItems: 2 });

    expect(served.map((item) => item.id)).toEqual([items[1]!.id, items[2]!.id]);
  });
});
