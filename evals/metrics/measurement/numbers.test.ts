import { describe, expect, it } from 'vitest';
import { countBy, mean, share } from './numbers';

describe('share', () => {
  it('is hits over total', () => {
    expect(share(3, 4)).toBe(0.75);
    expect(share(0, 4)).toBe(0);
  });

  it('is null when there is nothing to divide by', () => {
    expect(share(0, 0)).toBeNull();
  });
});

describe('mean', () => {
  it('is the arithmetic mean', () => {
    expect(mean([1, 2, 6])).toBe(3);
  });

  it('is null without values', () => {
    expect(mean([])).toBeNull();
  });
});

describe('countBy', () => {
  it('counts each id', () => {
    expect(countBy(['a', 'b', 'a'])).toEqual({ a: 2, b: 1 });
  });

  it('counts an id that looks like an object property', () => {
    expect(countBy(['constructor', 'toString', 'constructor'])).toEqual({
      constructor: 2,
      toString: 1,
    });
  });

  it('is empty without ids', () => {
    expect(countBy([])).toEqual({});
  });
});
