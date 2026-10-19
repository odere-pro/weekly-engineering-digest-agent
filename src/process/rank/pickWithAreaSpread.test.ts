import { describe, expect, it } from 'vitest';
import { pickWithAreaSpread } from './pickWithAreaSpread';
import { entryIds, entriesOf, scored } from '../__fixtures__/processKit';
import type { ScoredItem } from '../../classify/classification';

const inArea = (id: string, relevance: number, area: string) => scored(id, { relevance, area });

/** Ids picked from a list given best first, listed in that same rank order. */
function picked(items: ScoredItem[], topN: number): string[] {
  const entries = entriesOf(items);
  const chosen = pickWithAreaSpread(entries, topN);
  return entryIds(entries.filter((entry) => chosen.has(entry)));
}

describe('pickWithAreaSpread', () => {
  it('lets an area take at most 2 slots while another area has an item', () => {
    const items = [
      inArea('ai-1', 3, 'AI'),
      inArea('ai-2', 2.9, 'AI'),
      inArea('ai-3', 2.8, 'AI'),
      inArea('plat-1', 2.0, 'Platform'),
    ];

    expect(picked(items, 3)).toEqual(['ai-1', 'ai-2', 'plat-1']);
  });

  it('fills the remaining slots from a capped area when no other area has an item', () => {
    const items = [inArea('ai-1', 3, 'AI'), inArea('ai-2', 2.9, 'AI'), inArea('ai-3', 2.8, 'AI')];

    expect(picked(items, 3)).toEqual(['ai-1', 'ai-2', 'ai-3']);
  });

  it('spreads to lower-ranked areas first, then lists the selection in rank order', () => {
    const items = [
      inArea('ai-1', 3, 'AI'),
      inArea('ai-2', 2.9, 'AI'),
      inArea('ai-3', 2.8, 'AI'),
      inArea('ai-4', 2.7, 'AI'),
      inArea('plat-1', 1.6, 'Platform'),
      inArea('sec-1', 1.5, 'Security'),
    ];

    expect(picked(items, 5)).toEqual(['ai-1', 'ai-2', 'ai-3', 'plat-1', 'sec-1']);
  });

  it('prefers the less-filled capped area once every area has 2 slots', () => {
    const items = [
      inArea('a-1', 3, 'A'),
      inArea('a-2', 2.9, 'A'),
      inArea('a-3', 2.8, 'A'),
      inArea('a-4', 2.7, 'A'),
      inArea('b-1', 2.6, 'B'),
      inArea('b-2', 2.5, 'B'),
      inArea('b-3', 2.4, 'B'),
    ];

    expect(picked(items, 6)).toEqual(['a-1', 'a-2', 'a-3', 'b-1', 'b-2', 'b-3']);
  });

  it('groups areas ignoring case, whitespace and punctuation', () => {
    const items = [
      inArea('ai-1', 3, 'AI models'),
      inArea('ai-2', 2.9, 'ai models'),
      inArea('ai-3', 2.8, ' AI-Models '),
      inArea('plat-1', 2, 'Platform'),
    ];

    expect(picked(items, 3)).toEqual(['ai-1', 'ai-2', 'plat-1']);
  });

  it('picks nothing when topN is 0', () => {
    expect(picked([inArea('a', 3, 'A')], 0)).toEqual([]);
  });

  it('picks everything when topN is larger than the list', () => {
    const items = [inArea('a', 3, 'A'), inArea('b', 2, 'B')];

    expect(picked(items, 10)).toEqual(['a', 'b']);
  });

  it('picks nothing from an empty list', () => {
    expect(picked([], 3)).toEqual([]);
  });

  it('does not modify the list it is given', () => {
    const entries = Object.freeze(entriesOf([inArea('a', 3, 'A'), inArea('b', 2, 'A')]));

    expect(() => pickWithAreaSpread(entries, 1)).not.toThrow();
    expect(entries).toHaveLength(2);
  });
});
