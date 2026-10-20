import { describe, expect, it } from 'vitest';
import { makeItem } from '../../test/builders';
import { mergeByUrl } from './mergeItems';

describe('mergeByUrl', () => {
  it('puts the saved items first, then the new ones', () => {
    const saved = [makeItem({ url: 'https://a.test/1' })];
    const fetched = [makeItem({ url: 'https://a.test/2' })];

    expect(mergeByUrl(saved, fetched)).toEqual([...saved, ...fetched]);
  });

  it('keeps the saved item when the same page comes again, whatever the URL spelling', () => {
    const saved = makeItem({ url: 'https://A.test/post/?utm_source=x', title: 'Saved' });
    const again = makeItem({ url: 'https://a.test/post#top', title: 'Fresh' });

    expect(mergeByUrl([saved], [again]).map((item) => item.title)).toEqual(['Saved']);
  });

  it('keeps the first of a repeat inside the new items', () => {
    const [first, second] = [
      makeItem({ url: 'https://a.test/x', title: 'First' }),
      makeItem({ url: 'https://a.test/x/', title: 'Second' }),
    ];
    expect(mergeByUrl([], [first, second])).toEqual([first]);
  });

  it('does not change its inputs', () => {
    const saved = Object.freeze([makeItem()]);
    const fetched = Object.freeze([makeItem()]);
    expect(() => mergeByUrl(saved, fetched)).not.toThrow();
    expect(saved).toHaveLength(1);
  });
});
