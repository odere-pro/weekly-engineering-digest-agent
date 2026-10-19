import { describe, expect, it } from 'vitest';
import { stability } from './stability';

describe('stability', () => {
  it('is the mean pairwise overlap of the digests of repeated runs', () => {
    const result = stability([
      ['a', 'b', 'c', 'd', 'e'],
      ['a', 'b', 'c', 'd', 'x'],
      ['a', 'b', 'c', 'y', 'z'],
    ]);
    // overlaps: 4, 3, 3
    expect(result.value).toBeCloseTo(10 / 3);
  });

  it('is 5 for identical runs and 0 for disjoint ones', () => {
    const same = ['a', 'b', 'c', 'd', 'e'];
    expect(stability([same, same, same]).value).toBe(5);
    expect(stability([['a'], ['b']]).value).toBe(0);
  });

  it('is null with fewer than two runs', () => {
    expect(stability([['a']]).value).toBeNull();
    expect(stability([]).value).toBeNull();
  });
});

describe('stability runs', () => {
  const runs = [
    ['a', 'b', 'c'],
    ['a', 'b', 'x'],
    ['q', 'r', 's'],
  ];

  it('stores the item ids of every run', () => {
    expect(stability(runs).itemIdsByRun).toEqual(runs);
  });

  it('counts the runs and the runs that produced no item, so 0 can be read', () => {
    const result = stability([['a', 'b'], [], []]);

    expect(result.value).toBe(0);
    expect(result.detail).toEqual({ runs: 3, emptyRuns: 2 });
  });

  it('shows disjoint picks as no empty runs', () => {
    const result = stability([['a'], ['b']]);

    expect(result.value).toBe(0);
    expect(result.detail).toEqual({ runs: 2, emptyRuns: 0 });
  });

  it('copies the ids, so changing the input later changes nothing', () => {
    const input = [['a'], ['a']];
    const result = stability(input);
    input[0]?.push('z');
    expect(result.itemIdsByRun).toEqual([['a'], ['a']]);
  });

  it('names the repeated week in the note when it is given', () => {
    expect(stability(runs, '2026-W36').note).toBe('overlap of 3 runs of 2026-W36');
    expect(stability(runs).note).toBeUndefined();
  });

  it('is null with fewer than two runs but still shows what ran', () => {
    const result = stability([['a']]);
    expect(result.value).toBeNull();
    expect(result.itemIdsByRun).toEqual([['a']]);
  });

  it('has nothing to show without runs', () => {
    const result = stability([]);
    expect(result.value).toBeNull();
    expect(result.itemIdsByRun).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });
});
