import { describe, expect, it } from 'vitest';
import { ThresholdsSchema } from '../../../src/config/schema';
import { processStep } from '../../../src/process/process';
import { makeScoredItem } from '../../../test/builders';
import { DEFAULTS } from '../__fixtures__/records';
import { keepsItem, type FilterThresholds } from './keepsItem';

describe('keepsItem', () => {
  it('keeps an item at the thresholds and drops it just past each one', () => {
    const at = { relevance: 1.5, hype: 0.5, minorRelease: 0.5 };
    expect(keepsItem(at, DEFAULTS)).toBe(true);
    expect(keepsItem({ ...at, relevance: 1.49 }, DEFAULTS)).toBe(false);
    expect(keepsItem({ ...at, hype: 0.51 }, DEFAULTS)).toBe(false);
    expect(keepsItem({ ...at, minorRelease: 0.51 }, DEFAULTS)).toBe(false);
  });
});

describe('keepsItem against the process step', () => {
  // The sweep scores a threshold set with keepsItem; the pipeline applies it with processStep.
  // If a rule changes in src/process, this table fails here.
  const THRESHOLDS: FilterThresholds = { minRelevance: 1.5, maxHype: 0.6, maxMinorRelease: 0.75 };
  const table = [
    { name: 'sits exactly at every threshold', relevance: 1.5, hype: 0.6, minorRelease: 0.75 },
    { name: 'is clear of every threshold', relevance: 3, hype: 0, minorRelease: 0 },
    { name: 'is just under minRelevance', relevance: 1.49, hype: 0.1, minorRelease: 0.1 },
    { name: 'is just over maxHype', relevance: 2.5, hype: 0.61, minorRelease: 0.1 },
    { name: 'is just over maxMinorRelease', relevance: 2.5, hype: 0.1, minorRelease: 0.76 },
    { name: 'breaks every rule', relevance: 0.2, hype: 0.9, minorRelease: 0.9 },
  ];

  it.each(table)('agrees on an item that $name', ({ relevance, hype, minorRelease }) => {
    const item = makeScoredItem({}, { relevance, hype, minorRelease });
    const { dropped } = processStep({
      items: [item],
      sentUrls: new Set(),
      thresholds: { ...THRESHOLDS, guardFlag: 0.5 },
      topN: 5,
    });
    const processDrops = dropped.some((d) => d.reason !== 'below-top-n');
    expect(keepsItem(item.classification, THRESHOLDS)).toBe(!processDrops);
  });

  it('agrees on every item of a grid, at the thresholds in use', () => {
    const values = [0, 0.3, 0.5, 0.7, 1];
    const items = values.flatMap((hype, h) =>
      values.map((minorRelease, m) =>
        makeScoredItem(
          { title: `Item ${h}-${m}` },
          { relevance: 0.6 * (h + m), hype, minorRelease },
        ),
      ),
    );
    const { dropped } = processStep({
      items,
      sentUrls: new Set(),
      thresholds: { ...DEFAULTS, guardFlag: 0.5 },
      topN: items.length,
    });
    const droppedByThreshold = new Set(
      dropped.filter((d) => d.reason !== 'below-top-n').map((d) => d.itemId),
    );
    for (const item of items)
      expect(keepsItem(item.classification, DEFAULTS)).toBe(!droppedByThreshold.has(item.id));
  });

  it('agrees at the default thresholds of the config', () => {
    const defaults = ThresholdsSchema.parse({});
    const item = makeScoredItem(
      {},
      { relevance: defaults.minRelevance, hype: defaults.maxHype, minorRelease: 0 },
    );
    const { dropped } = processStep({
      items: [item],
      sentUrls: new Set(),
      thresholds: defaults,
      topN: 5,
    });
    expect(dropped).toEqual([]);
    expect(keepsItem(item.classification, defaults)).toBe(true);
  });
});
