import { describe, expect, it } from 'vitest';
import { cases } from '../__fixtures__/rescoreKit';
import { holdoutOf } from './holdoutOf';

describe('holdoutOf', () => {
  /** Two weeks (W40, W41) and six classifier cases k0 to k5. */
  function sixCases() {
    const set = cases();
    const base = set.classifier.cases[0]!;
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...base,
      item: { ...base.item, id: `k${i}` },
    }));
    const second = { ...set.weeks[0]!, weekId: '2026-W40' };
    return { ...set, weeks: [second, set.weeks[0]!], classifier: { reviewed: true, cases: many } };
  }

  it('keeps the named weeks and every third classifier case', () => {
    const out = holdoutOf(sixCases(), ['2026-W41']);

    expect(out.weeks.map((w) => w.weekId)).toEqual(['2026-W41']);
    expect(out.classifier.cases.map((c) => c.item.id)).toEqual(['k2', 'k5']);
  });

  it('keeps several named weeks in their order', () => {
    const out = holdoutOf(sixCases(), ['2026-W41', '2026-W40']);

    expect(out.weeks.map((w) => w.weekId)).toEqual(['2026-W40', '2026-W41']);
  });

  it('keeps no week when none matches, and still every third case', () => {
    const out = holdoutOf(sixCases(), ['2026-W01']);

    expect(out.weeks).toEqual([]);
    expect(out.classifier.cases).toHaveLength(2);
  });

  it('keeps the other parts of the set and does not change its input', () => {
    const set = sixCases();

    const out = holdoutOf(set, ['2026-W41']);

    expect(out.attacks).toBe(set.attacks);
    expect(out.classifier.reviewed).toBe(true);
    expect(set.weeks).toHaveLength(2);
    expect(set.classifier.cases).toHaveLength(6);
  });
});
