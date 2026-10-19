import { describe, expect, it } from 'vitest';
import { sample } from '../__fixtures__/calibrationKit';
import { blockValue, groupByRaw, pool, type Block } from './blocks';

const block = (rawSum: number, targetSum: number, count: number): Block => ({
  rawSum,
  targetSum,
  count,
});

describe('groupByRaw', () => {
  it('puts samples with the same raw score in one block, in rising raw order', () => {
    const blocks = groupByRaw([sample(2, 1), sample(1, 0), sample(1, 2)]);

    expect(blocks).toEqual([block(2, 2, 2), block(2, 1, 1)]);
  });

  it('returns no block for no sample', () => {
    expect(groupByRaw([])).toEqual([]);
  });
});

describe('pool', () => {
  it('keeps blocks whose means rise as they are', () => {
    const rising = [block(1, 0, 1), block(2, 1, 1), block(3, 3, 1)];

    expect(pool(rising)).toEqual(rising);
  });

  it('merges a falling pair into one block with their mean', () => {
    expect(pool([block(1, 2, 1), block(2, 0, 1)])).toEqual([block(3, 2, 2)]);
  });

  it('keeps merging backwards until the means stop falling', () => {
    // Targets 3, 2, 1 fall all the way: one block of three.
    expect(pool([block(1, 3, 1), block(2, 2, 1), block(3, 1, 1)])).toEqual([block(6, 6, 3)]);
  });

  it('merges blocks with equal means so that the knots rise strictly in calibrated', () => {
    expect(pool([block(1, 1, 1), block(2, 1, 1)])).toEqual([block(3, 2, 2)]);
  });

  it('does not change its input', () => {
    const input = [block(1, 2, 1), block(2, 0, 1)];

    pool(input);

    expect(input).toEqual([block(1, 2, 1), block(2, 0, 1)]);
  });
});

describe('blockValue', () => {
  it('is the mean raw score and the mean target of the block', () => {
    expect(blockValue(block(3, 2, 2))).toEqual({ raw: 1.5, calibrated: 1 });
  });
});
