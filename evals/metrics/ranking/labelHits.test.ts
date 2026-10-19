import { describe, expect, it } from 'vitest';
import { mustExcludeLeaks, mustIncludeRecall } from './labelHits';

describe('mustIncludeRecall', () => {
  it('averages the must-include items found in the digest per week', () => {
    const result = mustIncludeRecall([
      {
        mustInclude: ['a', 'b', 'c', 'd', 'e'],
        mustExclude: [],
        digestItemIds: ['a', 'b', 'c', 'z'],
      },
      { mustInclude: ['a', 'b', 'c', 'd', 'e'], mustExclude: [], digestItemIds: ['a', 'x'] },
    ]);
    expect(result.value).toBe(2);
  });

  it('is 0 for a week without a digest and null without weeks', () => {
    expect(
      mustIncludeRecall([{ mustInclude: ['a'], mustExclude: [], digestItemIds: [] }]).value,
    ).toBe(0);
    expect(mustIncludeRecall([]).value).toBeNull();
  });
});

describe('mustExcludeLeaks', () => {
  it('averages the must-exclude items found in the digest per week', () => {
    const result = mustExcludeLeaks([
      { mustInclude: [], mustExclude: ['x', 'y'], digestItemIds: ['x', 'y', 'a'] },
      { mustInclude: [], mustExclude: ['x'], digestItemIds: ['a'] },
      { mustInclude: [], mustExclude: [], digestItemIds: ['a'] },
      { mustInclude: [], mustExclude: ['q'], digestItemIds: ['q'] },
    ]);
    expect(result.value).toBe(0.75);
  });

  it('is null without weeks', () => {
    expect(mustExcludeLeaks([]).value).toBeNull();
  });
});

describe('labels the replay did not serve', () => {
  it('does not count one as found, even when the digest has it, and counts it as not visible', () => {
    const result = mustIncludeRecall([
      {
        mustInclude: ['a', 'b', 'c', 'd', 'e'],
        mustExclude: [],
        digestItemIds: ['a', 'b', 'e'],
        visibleIds: new Set(['a', 'b', 'c', 'd']),
      },
    ]);

    // e is in the digest but was never served: it is not counted as found either way.
    expect(result.value).toBe(2);
    expect(result.detail).toEqual({ notVisible: 1 });
    expect(result.note).toContain('1 labeled item');
  });

  it('adds up the not visible labels over the weeks', () => {
    const result = mustIncludeRecall([
      { mustInclude: ['a', 'b'], mustExclude: [], digestItemIds: [], visibleIds: new Set(['a']) },
      { mustInclude: ['c', 'd'], mustExclude: [], digestItemIds: [], visibleIds: new Set() },
    ]);

    expect(result.detail).toEqual({ notVisible: 3 });
  });

  it('leaves them out of the leaks too', () => {
    const result = mustExcludeLeaks([
      {
        mustInclude: [],
        mustExclude: ['x', 'y'],
        digestItemIds: ['x'],
        visibleIds: new Set(['x']),
      },
    ]);

    expect(result.value).toBe(1);
    expect(result.detail).toEqual({ notVisible: 1 });
  });

  it('treats every label as visible when the replay window is not given', () => {
    const result = mustIncludeRecall([
      { mustInclude: ['a', 'b'], mustExclude: [], digestItemIds: ['a'] },
    ]);

    expect(result.value).toBe(1);
    expect(result.detail).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it('shows no detail and no note when every label was served', () => {
    const result = mustExcludeLeaks([
      { mustInclude: [], mustExclude: ['x'], digestItemIds: [], visibleIds: new Set(['x']) },
    ]);

    expect(result).toEqual({ value: 0 });
  });
});
