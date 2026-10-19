import { describe, expect, it } from 'vitest';
import type { Source } from '../../../domain/schemas';
import { mergeEnriched } from './mergeEnriched';
import { normalizeEntry } from './normalizeEntry';
import type { Pair, RawEntry } from './types';

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const raw = (overrides: Partial<RawEntry> = {}): RawEntry => ({
  url: 'https://example.com/a',
  title: 'A title',
  text: '',
  publishedAt: '2026-10-10T08:00:00Z',
  ...overrides,
});
function pairOf(entry: RawEntry): Pair {
  const item = normalizeEntry(entry, source, { maxSummaryChars: 600 });
  if (!item) throw new Error('test entry is not usable');
  return { entry, item };
}

describe('mergeEnriched', () => {
  it('takes the summary of an entry whose text was filled in, as plain text', () => {
    const pairs = [pairOf(raw())];
    const enriched = [raw({ text: '<p>From the page &amp; more.</p>' })];

    const items = mergeEnriched(enriched, pairs, source, 600);

    expect(items[0]?.summary).toBe('From the page & more.');
  });

  it('keeps every other field of the item', () => {
    const pairs = [pairOf(raw({ title: ' Kept ' }))];

    const [item] = mergeEnriched([raw({ text: 'New text', title: 'Ignored' })], pairs, source, 600);

    expect(item).toEqual({ ...pairs[0]?.item, summary: 'New text' });
    expect(item?.title).toBe('Kept');
  });

  it('applies the summary cap to the page text', () => {
    const pairs = [pairOf(raw())];
    const [item] = mergeEnriched([raw({ text: 'word '.repeat(100) })], pairs, source, 40);
    expect(item?.summary.length).toBeLessThanOrEqual(40);
  });

  it('keeps the item as it was when the text did not change', () => {
    const pairs = [pairOf(raw({ text: 'Feed text' }))];
    const items = mergeEnriched([raw({ text: 'Feed text' })], pairs, source, 600);
    expect(items[0]).toBe(pairs[0]?.item);
  });

  it('keeps the item as it was when no enriched entry matches its place', () => {
    const pairs = [pairOf(raw()), pairOf(raw({ url: 'https://example.com/b' }))];
    const items = mergeEnriched([raw({ text: 'Only the first' })], pairs, source, 600);
    expect(items.map((item) => item.summary)).toEqual(['Only the first', '']);
  });

  it('keeps the item when the enriched entry cannot become one', () => {
    const pairs = [pairOf(raw())];
    const items = mergeEnriched([raw({ text: 'x', publishedAt: 'sometime' })], pairs, source, 600);
    expect(items[0]).toBe(pairs[0]?.item);
  });

  it('matches by position, one item per pair', () => {
    const pairs = [pairOf(raw()), pairOf(raw({ url: 'https://example.com/b' }))];
    const enriched = [
      raw({ text: 'First' }),
      raw({ url: 'https://example.com/b', text: 'Second' }),
    ];

    expect(mergeEnriched(enriched, pairs, source, 600).map((item) => item.summary)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('returns nothing for no pairs', () => {
    expect(mergeEnriched([], [], source, 600)).toEqual([]);
  });
});
