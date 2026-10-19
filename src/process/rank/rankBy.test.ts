import { describe, expect, it } from 'vitest';
import { byRank, rankBy } from './rankBy';
import { entryIds, entriesOf, scored } from '../__fixtures__/processKit';
import type { ScoredItem } from '../../classify/classification';

/** Ids in the order `rankBy(order)` gives, for any input order. */
function ranked(items: readonly ScoredItem[], order?: readonly string[]): string[] {
  return entryIds(entriesOf(items).sort(rankBy(order)));
}

describe('byRank', () => {
  it('ranks by relevance descending', () => {
    const items = [
      scored('low', { relevance: 2 }),
      scored('top', { relevance: 3 }),
      scored('mid', { relevance: 2.5 }),
    ];

    expect(ranked(items)).toEqual(['top', 'mid', 'low']);
  });

  it('breaks relevance ties by areaConfidence descending', () => {
    const items = [
      scored('a-unsure', { relevance: 2.5, areaConfidence: 0.6 }),
      scored('z-sure', { relevance: 2.5, areaConfidence: 0.95 }),
    ];

    expect(ranked(items)).toEqual(['z-sure', 'a-unsure']);
  });

  it('breaks remaining ties by publishedAt descending, comparing instants not strings', () => {
    const items = [
      scored('older', {}, { publishedAt: '2026-10-10T09:00:00Z' }),
      // 2026-10-12T08:00Z, but sorts after the others as a plain string
      scored('newest', {}, { publishedAt: '2026-10-12T10:00:00+02:00' }),
      scored('middle', {}, { publishedAt: '2026-10-11T09:00:00Z' }),
    ];

    expect(ranked(items)).toEqual(['newest', 'middle', 'older']);
  });

  it('ranks an unparseable publishedAt as the oldest instead of failing', () => {
    const items = [
      scored('broken', {}, { publishedAt: 'not-a-date' }),
      scored('dated', {}, { publishedAt: '2026-10-10T09:00:00Z' }),
    ];

    expect(ranked(items)).toEqual(['dated', 'broken']);
  });

  it('breaks full ties by id ascending, whatever the input order', () => {
    const shared = { publishedAt: '2026-10-12T09:00:00Z' };
    const items = [scored('c', {}, shared), scored('a', {}, shared), scored('b', {}, shared)];

    expect(ranked(items)).toEqual(['a', 'b', 'c']);
    expect(ranked([...items].reverse())).toEqual(['a', 'b', 'c']);
  });

  it('compares ids by code unit, not by the machine locale', () => {
    // localeCompare puts "a" before "B"; code-unit order puts "B" (66) before "a" (97).
    expect(ranked([scored('a'), scored('B')])).toEqual(['B', 'a']);
  });

  it('settles a full tie between items sharing an id by source, whatever the input order', () => {
    const fromA = scored('same', {}, { sourceId: 'a-feed' });
    const fromB = scored('same', {}, { sourceId: 'b-feed' });
    const sourceOf = (items: readonly ScoredItem[]): string[] =>
      entriesOf(items)
        .sort(byRank)
        .map((entry) => entry.item.sourceId);

    expect(sourceOf([fromA, fromB])).toEqual(['a-feed', 'b-feed']);
    expect(sourceOf([fromB, fromA])).toEqual(['a-feed', 'b-feed']);
  });

  it('settles ties between same-id, same-source items by title, then URL', () => {
    const byTitleA = scored('same', {}, { title: 'Alpha', url: 'https://example.com/2' });
    const byTitleB = scored('same', {}, { title: 'Beta', url: 'https://example.com/1' });
    const byUrlA = scored('other', {}, { title: 'Gamma', url: 'https://example.com/3' });
    const byUrlB = scored('other', {}, { title: 'Gamma', url: 'https://example.com/4' });
    const urlsOf = (items: readonly ScoredItem[]): string[] =>
      entriesOf(items)
        .sort(byRank)
        .map((entry) => entry.item.url);

    expect(urlsOf([byTitleB, byTitleA])).toEqual([byTitleA.url, byTitleB.url]);
    expect(urlsOf([byUrlB, byUrlA])).toEqual([byUrlA.url, byUrlB.url]);
  });

  it('returns 0 for an entry compared with itself', () => {
    const [entry] = entriesOf([scored('a')]);

    expect(entry && byRank(entry, entry)).toBe(0);
  });
});

describe('rankBy with a pairwise order (W11-07)', () => {
  const low = scored('low', { relevance: 2 });
  const high = scored('high', { relevance: 3 });

  it('is plain byRank when there is no order', () => {
    expect(ranked([low, high])).toEqual(['high', 'low']);
    expect(rankBy(undefined)).toBe(byRank);
  });

  it('ranks listed items by their position before relevance', () => {
    expect(ranked([high, low], ['low', 'high'])).toEqual(['low', 'high']);
  });

  it('ranks items outside the order after the listed ones', () => {
    expect(ranked([high, low], ['low'])).toEqual(['low', 'high']);
  });

  it('ranks the unlisted items among themselves by byRank', () => {
    const items = [
      low,
      high,
      scored('mid', { relevance: 2.5 }),
      scored('listed', { relevance: 0 }),
    ];

    expect(ranked(items, ['listed'])).toEqual(['listed', 'high', 'mid', 'low']);
  });

  it('ignores ids in the order that no item has', () => {
    expect(ranked([low, high], ['ghost', 'low'])).toEqual(['low', 'high']);
  });

  it('does not modify the order it is given', () => {
    const order = Object.freeze(['low', 'high']);

    expect(() => ranked([high, low], order)).not.toThrow();
  });
});
