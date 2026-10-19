import { describe, expect, it } from 'vitest';
import { chunk } from './chunk';

describe('chunk', () => {
  it('splits into runs of at most the size, keeping the order', () => {
    const values = Array.from({ length: 25 }, (_, index) => index);

    const runs = chunk(values, 10);

    expect(runs.map((run) => run.length)).toEqual([10, 10, 5]);
    expect(runs.flat()).toEqual(values);
  });

  it('makes no short run when the length is a multiple of the size', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('returns one run when the values fit', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns no runs for no values', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('does not change the input', () => {
    const values = Object.freeze([1, 2, 3]);

    expect(chunk(values, 2)).toEqual([[1, 2], [3]]);
    expect(values).toEqual([1, 2, 3]);
  });
});
