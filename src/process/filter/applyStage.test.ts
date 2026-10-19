import { describe, expect, it } from 'vitest';
import { applyStage, drop, type Partition, type Stage } from './applyStage';
import { entriesOf, entryIds, scored } from '../__fixtures__/processKit';

const dropsId =
  (target: string): Stage['drops'] =>
  () =>
  (entry) =>
    entry.item.id === target;

describe('drop', () => {
  it('names the item and the reason', () => {
    expect(drop(scored('a'), 'hype')).toEqual({ itemId: 'a', reason: 'hype' });
  });
});

describe('applyStage', () => {
  const start = (ids: string[]): Partition => ({
    kept: entriesOf(ids.map((id) => scored(id))),
    dropped: [],
  });

  it('moves the entries a stage drops from kept to dropped, under its reason', () => {
    const out = applyStage(start(['a', 'b', 'c']), { reason: 'hype', drops: dropsId('b') });

    expect(entryIds(out.kept)).toEqual(['a', 'c']);
    expect(out.dropped).toEqual([{ itemId: 'b', reason: 'hype' }]);
  });

  it('appends to the drops of earlier stages and keeps the order of the entries', () => {
    const first = applyStage(start(['a', 'b', 'c']), {
      reason: 'sent-before',
      drops: dropsId('c'),
    });
    const second = applyStage(first, { reason: 'hype', drops: dropsId('a') });

    expect(entryIds(second.kept)).toEqual(['b']);
    expect(second.dropped).toEqual([
      { itemId: 'c', reason: 'sent-before' },
      { itemId: 'a', reason: 'hype' },
    ]);
  });

  it('hands the survivors to the stage, so a stage can compare entries with each other', () => {
    const seen: string[][] = [];
    const stage: Stage = {
      reason: 'duplicate',
      drops: (survivors) => {
        seen.push(entryIds(survivors));
        return () => false;
      },
    };

    applyStage(start(['a', 'b']), stage);

    expect(seen).toEqual([['a', 'b']]);
  });

  it('changes nothing when a stage drops nothing', () => {
    const before = start(['a', 'b']);

    const out = applyStage(before, { reason: 'hype', drops: dropsId('none') });

    expect(entryIds(out.kept)).toEqual(['a', 'b']);
    expect(out.dropped).toEqual([]);
  });

  it('does not modify the partition it is given', () => {
    const before = start(['a', 'b']);
    const snapshot = structuredClone(before);

    applyStage(before, { reason: 'hype', drops: dropsId('a') });

    expect(before).toEqual(snapshot);
  });
});
