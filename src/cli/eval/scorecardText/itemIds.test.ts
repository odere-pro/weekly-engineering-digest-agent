// itemIdsByRunLines: what each repeated run picked, as short ids safe to print.
import { describe, expect, it } from 'vitest';
import type { MetricResult } from '../../../../evals/schema';
import { ITEM_IDS_TITLE, SHORT_ID_CHARS, itemIdsByRunLines } from './itemIds';

function stability(itemIdsByRun?: string[][]): MetricResult {
  return {
    id: 'stability',
    label: 'Stability',
    unit: 'count',
    value: 0,
    gate: { kind: 'none' },
    pass: null,
    ...(itemIdsByRun ? { itemIdsByRun } : {}),
  };
}

describe('itemIdsByRunLines', () => {
  it('prints nothing for a metric without ids', () => {
    expect(itemIdsByRunLines([stability()])).toEqual([]);
  });

  it('lists each run with its item count and the first characters of each id', () => {
    const lines = itemIdsByRunLines([
      stability([['a1b2c3d4e5f60718', '1122334455667788'], ['99aabbccddeeff00']]),
    ]);
    expect(lines).toEqual([
      '  Stability run 1: 2 items: a1b2c3d4 11223344',
      '  Stability run 2: 1 item: 99aabbcc',
    ]);
  });

  it('shows an empty run as "no items"', () => {
    expect(itemIdsByRunLines([stability([[]])])).toEqual(['  Stability run 1: no items']);
  });

  it('shows a link that matched no item as "unmatched", never the URL', () => {
    const lines = itemIdsByRunLines([
      stability([['unmatched:https://evil.example/\u{202E}x', 'a1b2c3d4e5f60718']]),
    ]);
    expect(lines).toEqual(['  Stability run 1: 2 items: unmatched a1b2c3d4']);
  });

  it('cleans an id with a control or bidi character before it cuts', () => {
    const lines = itemIdsByRunLines([stability([['ab\u{1b}[31mcdefgh', '\u{202E}abcdefghij']])]);
    expect(lines).toEqual(['  Stability run 1: 2 items: ab [31mc abcdefgh']);
  });

  it('does not split an emoji when it cuts an id', () => {
    const id = `abcdefg\u{1F600}tail`;
    expect(itemIdsByRunLines([stability([[id]])])).toEqual([
      `  Stability run 1: 1 item: abcdefg\u{1F600}`,
    ]);
  });

  it('names the number of characters it keeps in the section title', () => {
    expect(SHORT_ID_CHARS).toBe(8);
    expect(ITEM_IDS_TITLE).toBe(
      'Item ids by run (first 8 characters; the scorecard file has them in full):',
    );
  });
});
