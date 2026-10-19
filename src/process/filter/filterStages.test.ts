import { describe, expect, it } from 'vitest';
import { applyStage, type Partition } from './applyStage';
import { filterStages } from './filterStages';
import {
  defaultThresholds as thresholds,
  entriesOf,
  entryIds,
  scored,
} from '../__fixtures__/processKit';
import type { ScoredItem } from '../../classify/classification';
import type { Thresholds } from '../../config/schema';

/** Runs every stage over `items`, in the order given, the way `processStep` does after ranking. */
function filter(
  items: readonly ScoredItem[],
  options: { sentUrls?: readonly string[]; thresholds?: Thresholds } = {},
): Partition {
  const stages = filterStages(new Set(options.sentUrls ?? []), options.thresholds ?? thresholds);
  return stages.reduce(applyStage, { kept: entriesOf(items), dropped: [] });
}

describe('filterStages', () => {
  it('lists the drop rules in the order the contract applies them', () => {
    const reasons = filterStages(new Set(), thresholds).map((stage) => stage.reason);

    expect(reasons).toEqual(['sent-before', 'duplicate', 'low-relevance', 'hype', 'minor-release']);
  });

  it('gives each score combination the reason of the plain comparisons, NaN included', () => {
    const relevances = [0, thresholds.minRelevance - 0.01, thresholds.minRelevance, 3, Number.NaN];
    const hypes = [0, thresholds.maxHype, thresholds.maxHype + 0.01, 1, Number.NaN];
    const minors = [
      0,
      thresholds.maxMinorRelease,
      thresholds.maxMinorRelease + 0.01,
      1,
      Number.NaN,
    ];
    // The rules as the original three stages wrote them: each only sees what the last one kept.
    const reasonFor = (relevance: number, hype: number, minorRelease: number) => {
      if (relevance < thresholds.minRelevance) return 'low-relevance';
      if (hype > thresholds.maxHype) return 'hype';
      if (minorRelease > thresholds.maxMinorRelease) return 'minor-release';
      return undefined;
    };

    for (const relevance of relevances) {
      for (const hype of hypes) {
        for (const minorRelease of minors) {
          const out = filter([scored('x', { relevance, hype, minorRelease })]);

          expect(out.dropped.map((dropped) => dropped.reason)).toEqual(
            [reasonFor(relevance, hype, minorRelease)].filter(Boolean),
          );
        }
      }
    }
  });

  it('keeps an item whose score is not a number: no comparison with NaN is true', () => {
    const out = filter([scored('x', { relevance: Number.NaN, hype: Number.NaN })]);

    expect(entryIds(out.kept)).toEqual(['x']);
    expect(out.dropped).toEqual([]);
  });

  it('keeps clean items and reports nothing dropped', () => {
    const out = filter([scored('a'), scored('b')]);

    expect(entryIds(out.kept)).toEqual(['a', 'b']);
    expect(out.dropped).toEqual([]);
  });

  it('drops low-relevance items below minRelevance but keeps those at the threshold', () => {
    const out = filter([
      scored('low', { relevance: thresholds.minRelevance - 0.1 }),
      scored('edge', { relevance: thresholds.minRelevance }),
    ]);

    expect(entryIds(out.kept)).toEqual(['edge']);
    expect(out.dropped).toEqual([{ itemId: 'low', reason: 'low-relevance' }]);
  });

  it('drops hype above maxHype but keeps hype at the threshold', () => {
    const out = filter([
      scored('hyped', { hype: thresholds.maxHype + 0.1 }),
      scored('edge', { hype: thresholds.maxHype }),
    ]);

    expect(entryIds(out.kept)).toEqual(['edge']);
    expect(out.dropped).toEqual([{ itemId: 'hyped', reason: 'hype' }]);
  });

  it('drops minor releases above maxMinorRelease but keeps those at the threshold', () => {
    const out = filter([
      scored('patch', { minorRelease: thresholds.maxMinorRelease + 0.1 }),
      scored('edge', { minorRelease: thresholds.maxMinorRelease }),
    ]);

    expect(entryIds(out.kept)).toEqual(['edge']);
    expect(out.dropped).toEqual([{ itemId: 'patch', reason: 'minor-release' }]);
  });

  it('uses thresholds from the input, not built-in constants', () => {
    const strict = { ...thresholds, minRelevance: 2.9, maxHype: 0.05, maxMinorRelease: 0.05 };
    const out = filter(
      [
        scored('ok', { relevance: 3, hype: 0, minorRelease: 0 }),
        scored('meh', { relevance: 2.5 }),
        scored('hype', { relevance: 3, hype: 0.1, minorRelease: 0 }),
        scored('minor', { relevance: 3, hype: 0, minorRelease: 0.1 }),
      ],
      { thresholds: strict },
    );

    expect(entryIds(out.kept)).toEqual(['ok']);
    expect(out.dropped).toEqual([
      { itemId: 'meh', reason: 'low-relevance' },
      { itemId: 'hype', reason: 'hype' },
      { itemId: 'minor', reason: 'minor-release' },
    ]);
  });

  it('reports one reason per item, the first that fits, listed stage by stage', () => {
    const everything = scored(
      'x',
      { relevance: 0, hype: 1, minorRelease: 1 },
      { url: 'https://example.com/sent' },
    );
    const hypeAndMinor = scored('y', { hype: 1, minorRelease: 1 });
    const lowAndHype = scored('z', { relevance: 0, hype: 1 });

    const out = filter([everything, hypeAndMinor, lowAndHype], {
      sentUrls: ['https://example.com/sent'],
    });

    expect(out.kept).toEqual([]);
    expect(out.dropped).toEqual([
      { itemId: 'x', reason: 'sent-before' },
      { itemId: 'z', reason: 'low-relevance' },
      { itemId: 'y', reason: 'hype' },
    ]);
  });

  it('drops a sent URL before duplicates, so a sent copy does not hide a fresh one', () => {
    const sent = scored(
      'sent',
      { relevance: 3 },
      { sourceId: 's1', title: 'Same', url: 'https://example.com/sent' },
    );
    const fresh = scored(
      'fresh',
      { relevance: 2 },
      { sourceId: 's2', title: 'Same', url: 'https://example.com/fresh' },
    );

    const out = filter([sent, fresh], { sentUrls: ['https://example.com/sent'] });

    expect(entryIds(out.kept)).toEqual(['fresh']);
    expect(out.dropped).toEqual([{ itemId: 'sent', reason: 'sent-before' }]);
  });

  it('drops duplicates before the thresholds, so a filtered winner takes its story with it', () => {
    const winner = scored('w', { relevance: 3, hype: 0.9 }, { sourceId: 's1', title: 'A story' });
    const loser = scored('l', { relevance: 2, hype: 0.1 }, { sourceId: 's2', title: 'A story' });

    const out = filter([winner, loser]);

    expect(out.kept).toEqual([]);
    expect(out.dropped).toEqual([
      { itemId: 'l', reason: 'duplicate' },
      { itemId: 'w', reason: 'hype' },
    ]);
  });
});
