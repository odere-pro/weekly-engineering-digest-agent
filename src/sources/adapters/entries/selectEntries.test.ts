import { describe, expect, it } from 'vitest';
import type { Source } from '../../../domain/schemas';
import type { FetchWindow } from '../../SourceFetcher';
import { normalizeEntry } from './normalizeEntry';
import { selectEntries, withDistinctLinks } from './selectEntries';
import type { Pair, RawEntry } from './types';

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const window = (overrides: Partial<FetchWindow> = {}): FetchWindow => ({
  since: new Date('2026-10-05T00:00:00Z'),
  until: new Date('2026-10-13T00:00:00Z'),
  maxItems: 20,
  ...overrides,
});
const raw = (overrides: Partial<RawEntry> = {}): RawEntry => ({
  url: 'https://example.com/a',
  title: 'A title',
  text: 'Some text',
  publishedAt: '2026-10-10T08:00:00Z',
  ...overrides,
});
/** The pair the reading step would have made for this entry. */
function pairOf(entry: RawEntry): Pair {
  const item = normalizeEntry(entry, source, { maxSummaryChars: 600 });
  if (!item) throw new Error('test entry is not usable');
  return { entry, item };
}
const urlsOf = (pairs: readonly Pair[]): string[] => pairs.map(({ item }) => item.url);

describe('withDistinctLinks', () => {
  it('gives entries that share a link their entry id, and leaves distinct links alone', () => {
    const pairs = [
      pairOf(raw({ url: 'https://example.com/notes', entryId: 'a' })),
      pairOf(raw({ url: 'https://example.com/notes', entryId: 'b' })),
      pairOf(raw({ url: 'https://example.com/solo', entryId: 'c' })),
    ];

    const result = withDistinctLinks(pairs, source, 600);

    expect(urlsOf(result)).toEqual([
      'https://example.com/notes?entry=a',
      'https://example.com/notes?entry=b',
      'https://example.com/solo',
    ]);
    expect(new Set(result.map(({ item }) => item.id)).size).toBe(3);
  });

  it('judges the whole list, so an entry keeps its link whatever else is in the window', () => {
    const shared = [
      pairOf(raw({ url: 'https://example.com/notes', entryId: 'a' })),
      pairOf(raw({ url: 'https://example.com/notes', entryId: 'b' })),
    ];
    expect(urlsOf(withDistinctLinks(shared, source, 600))[0]).toBe(
      'https://example.com/notes?entry=a',
    );
    expect(urlsOf(withDistinctLinks(shared.slice(0, 1), source, 600))[0]).toBe(
      'https://example.com/notes',
    );
  });

  it('keeps the link of a shared-link entry that has no entry id', () => {
    const pairs = [
      pairOf(raw({ url: 'https://example.com/notes' })),
      pairOf(raw({ url: 'https://example.com/notes', entryId: 'b' })),
    ];
    expect(urlsOf(withDistinctLinks(pairs, source, 600))).toEqual([
      'https://example.com/notes',
      'https://example.com/notes?entry=b',
    ]);
  });

  it('returns new pairs and does not change the ones it was given', () => {
    const pairs = [
      pairOf(raw({ url: 'https://example.com/notes', entryId: 'a' })),
      pairOf(raw({ url: 'https://example.com/notes', entryId: 'b' })),
    ];
    const before = urlsOf(pairs);

    withDistinctLinks(pairs, source, 600);

    expect(urlsOf(pairs)).toEqual(before);
  });
});

describe('selectEntries', () => {
  it('keeps the entries in the window, newest first, up to the cap', () => {
    const pairs = [
      pairOf(raw({ url: 'https://example.com/1', publishedAt: '2026-10-06T00:00:00Z' })),
      pairOf(raw({ url: 'https://example.com/2', publishedAt: '2026-10-12T00:00:00Z' })),
      pairOf(raw({ url: 'https://example.com/3', publishedAt: '2026-10-09T00:00:00Z' })),
      pairOf(raw({ url: 'https://example.com/old', publishedAt: '2026-09-01T00:00:00Z' })),
      pairOf(raw({ url: 'https://example.com/future', publishedAt: '2026-11-01T00:00:00Z' })),
    ];

    expect(urlsOf(selectEntries(pairs, source, window({ maxItems: 2 }), 600))).toEqual([
      'https://example.com/2',
      'https://example.com/3',
    ]);
  });

  it('includes the two edges of the window', () => {
    const pairs = [
      pairOf(raw({ url: 'https://example.com/since', publishedAt: '2026-10-05T00:00:00Z' })),
      pairOf(raw({ url: 'https://example.com/until', publishedAt: '2026-10-13T00:00:00Z' })),
    ];
    expect(urlsOf(selectEntries(pairs, source, window(), 600))).toEqual([
      'https://example.com/until',
      'https://example.com/since',
    ]);
  });

  it('applies the cap after the window, so old entries cannot take a place', () => {
    const pairs = [
      pairOf(raw({ url: 'https://example.com/future', publishedAt: '2026-11-01T00:00:00Z' })),
      pairOf(raw({ url: 'https://example.com/in', publishedAt: '2026-10-08T00:00:00Z' })),
    ];
    expect(urlsOf(selectEntries(pairs, source, window({ maxItems: 1 }), 600))).toEqual([
      'https://example.com/in',
    ]);
  });

  it('gives every pair its distinct link before it picks', () => {
    const pairs = [
      pairOf(
        raw({
          url: 'https://example.com/notes',
          entryId: 'a',
          publishedAt: '2026-10-10T00:00:00Z',
        }),
      ),
      pairOf(
        raw({
          url: 'https://example.com/notes',
          entryId: 'b',
          publishedAt: '2026-10-09T00:00:00Z',
        }),
      ),
    ];
    expect(urlsOf(selectEntries(pairs, source, window(), 600))).toEqual([
      'https://example.com/notes?entry=a',
      'https://example.com/notes?entry=b',
    ]);
  });

  it('tells shared links apart over the whole feed, even when one entry is outside the window', () => {
    const pairs = [
      pairOf(
        raw({
          url: 'https://example.com/notes',
          entryId: 'recent',
          publishedAt: '2026-10-10T00:00:00Z',
        }),
      ),
      pairOf(
        raw({
          url: 'https://example.com/notes',
          entryId: 'old',
          publishedAt: '2026-09-01T00:00:00Z',
        }),
      ),
    ];

    expect(urlsOf(selectEntries(pairs, source, window(), 600))).toEqual([
      'https://example.com/notes?entry=recent',
    ]);
  });

  it('keeps the order of entries with the same date', () => {
    const date = '2026-10-10T00:00:00Z';
    const pairs = ['x', 'y', 'z'].map((name) =>
      pairOf(raw({ url: `https://example.com/${name}`, publishedAt: date })),
    );
    expect(urlsOf(selectEntries(pairs, source, window(), 600))).toEqual([
      'https://example.com/x',
      'https://example.com/y',
      'https://example.com/z',
    ]);
  });

  it('returns an empty list for no entries or a cap of zero', () => {
    expect(selectEntries([], source, window(), 600)).toEqual([]);
    expect(selectEntries([pairOf(raw())], source, window({ maxItems: 0 }), 600)).toEqual([]);
  });

  it('does not reorder the list it was given', () => {
    const pairs = [
      pairOf(raw({ url: 'https://example.com/1', publishedAt: '2026-10-06T00:00:00Z' })),
      pairOf(raw({ url: 'https://example.com/2', publishedAt: '2026-10-12T00:00:00Z' })),
    ];
    const before = urlsOf(pairs);

    selectEntries(pairs, source, window(), 600);

    expect(urlsOf(pairs)).toEqual(before);
  });
});
