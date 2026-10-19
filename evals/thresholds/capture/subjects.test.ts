import { describe, expect, it } from 'vitest';
import { makeDraft, makeItem } from '../../../test/builders';
import { evalSet } from '../__fixtures__/captureKit';
import { draftSubjects, guardSubjects, labelOf } from './subjects';

describe('labelOf', () => {
  const labels = { mustInclude: ['a'], mustExclude: ['b'] };

  it('names the label the maintainer gave the item', () => {
    expect(labelOf(labels, 'a')).toBe('mustInclude');
    expect(labelOf(labels, 'b')).toBe('mustExclude');
  });

  it('is null for an item the week does not mention', () => {
    expect(labelOf(labels, 'c')).toBeNull();
  });
});

describe('guardSubjects', () => {
  it('lists every week item as clean, then every attack, in the order they are stored', () => {
    const set = evalSet();
    const subjects = guardSubjects(set);
    expect(subjects.map((s) => [s.kind, s.from])).toEqual([
      ['clean', '2026-W40'],
      ['clean', '2026-W40'],
      ['clean', '2026-W40'],
      ['attack', 'attack-01'],
    ]);
    expect(subjects.map((s) => s.item)).toEqual([
      ...set.weeks.flatMap((w) => w.items),
      ...set.attacks.map((a) => a.item),
    ]);
  });

  it('has no subjects for an empty set', () => {
    expect(guardSubjects({ ...evalSet(), weeks: [], attacks: [] })).toEqual([]);
  });
});

describe('draftSubjects', () => {
  it('lists the planted draft, then the same draft without its planted item', () => {
    const [planted, control] = draftSubjects(evalSet());
    expect(planted).toMatchObject({ caseId: 'grounding-01', draft: 'planted' });
    expect(control).toMatchObject({ caseId: 'grounding-01', draft: 'control' });
    expect(control?.sources).toEqual(planted?.sources);
    expect(control?.value.digest.items.length).toBe((planted?.value.digest.items.length ?? 0) - 1);
  });

  it('has no control for a draft that holds only the planted item', () => {
    const source = makeItem();
    const set = {
      ...evalSet(),
      grounding: [
        { id: 'g1', draft: makeDraft([source]), sources: [source], plantedItemId: source.id },
      ],
    };
    expect(draftSubjects(set).map((s) => s.draft)).toEqual(['planted']);
  });
});
