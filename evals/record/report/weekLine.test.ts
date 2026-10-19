import { describe, expect, it } from 'vitest';
import { itemsOnDay } from '../__fixtures__/recordKit';
import { THIN_WEEK_MIN_ITEMS, weekLine } from './weekLine';

describe('weekLine', () => {
  it('shows the week id and the item count, right-aligned to eight characters', () => {
    expect(weekLine({ weekId: '2021-W02', items: itemsOnDay('2021-01-12', 12) })).toBe(
      '  2021-W02  12 items',
    );
    expect(weekLine({ weekId: '2021-W02', items: itemsOnDay('2021-01-12', 100) })).toBe(
      '  2021-W02  100 items',
    );
  });

  it('warns about a week with fewer items than the minimum, and only that week', () => {
    const thin = weekLine({
      weekId: '2021-W01',
      items: itemsOnDay('2021-01-05', THIN_WEEK_MIN_ITEMS - 1),
    });
    const enough = weekLine({
      weekId: '2021-W02',
      items: itemsOnDay('2021-01-12', THIN_WEEK_MIN_ITEMS),
    });

    expect(THIN_WEEK_MIN_ITEMS).toBe(10);
    expect(thin).toBe(
      '  2021-W01   9 items  WARNING: fewer than 10 items; feeds often keep only 10-20 entries',
    );
    expect(enough).not.toContain('WARNING');
  });

  it('warns about an empty week', () => {
    expect(weekLine({ weekId: '2021-W03', items: [] })).toBe(
      '  2021-W03   0 items  WARNING: fewer than 10 items; feeds often keep only 10-20 entries',
    );
  });

  it('says how many items an earlier run had and how many this run added', () => {
    expect(
      weekLine({ weekId: '2021-W02', items: itemsOnDay('2021-01-12', 12), alreadyRecorded: 10 }),
    ).toBe('  2021-W02  12 items  10 already recorded, 2 added');
  });

  it('says nothing was added when a re-run found nothing new', () => {
    expect(
      weekLine({ weekId: '2021-W02', items: itemsOnDay('2021-01-12', 12), alreadyRecorded: 12 }),
    ).toBe('  2021-W02  12 items  12 already recorded, 0 added');
  });

  it('joins the thin-week warning and the recorded count with a semicolon', () => {
    expect(
      weekLine({ weekId: '2021-W02', items: itemsOnDay('2021-01-12', 3), alreadyRecorded: 2 }),
    ).toBe(
      '  2021-W02   3 items  WARNING: fewer than 10 items; feeds often keep only 10-20 entries; 2 already recorded, 1 added',
    );
  });

  it('counts one item in the singular', () => {
    expect(weekLine({ weekId: '2021-W02', items: itemsOnDay('2021-01-12', 1) })).toMatch(
      /^ {2}2021-W02 {4}1 item {2}WARNING/,
    );
  });
});
