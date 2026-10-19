import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeItem } from '../../test/builders';
import { WEEK_40, WEEK_41, useCasesDir, weekItems, writeJson, writeWeek } from '../evalKit';
import { loadWeek, loadWeeks } from './loadWeeks';

const root = useCasesDir();
const weeksDir = (): string => join(root(), 'weeks');

describe('loadWeek', () => {
  it('returns the items and the labels of the week', async () => {
    const items = await writeWeek(root(), WEEK_40, '2026-09-30T09:00:00Z');

    const week = await loadWeek(weeksDir(), WEEK_40);

    expect(week.weekId).toBe(WEEK_40);
    expect(week.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(week.labels.mustInclude).toEqual(items.slice(0, 5).map((item) => item.id));
    expect(week.labels.mustExclude).toEqual([items[5]!.id]);
  });

  it('names items.json when the week has none', async () => {
    await mkdir(join(weeksDir(), WEEK_40), { recursive: true });

    await expect(loadWeek(weeksDir(), WEEK_40)).rejects.toThrow(/items\.json is missing/);
  });

  it('rejects an item published outside its week and names it', async () => {
    const stray = makeItem({ publishedAt: '2026-10-20T09:00:00Z' });
    await writeJson(root(), `weeks/${WEEK_40}/items.json`, [stray]);
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, { mustInclude: [], mustExclude: [] });

    await expect(loadWeek(weeksDir(), WEEK_40)).rejects.toThrow(
      new RegExp(`1 item\\(s\\) were not published in ${WEEK_40}, for example ${stray.id}`),
    );
  });

  it('rejects labels that name an item the week does not have', async () => {
    const items = weekItems('2026-09-30T09:00:00Z', 'x');
    await writeJson(root(), `weeks/${WEEK_40}/items.json`, items);
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, {
      mustInclude: [...items.slice(0, 4).map((item) => item.id), 'ghost'],
      mustExclude: ['phantom'],
    });

    await expect(loadWeek(weeksDir(), WEEK_40)).rejects.toThrow(
      /ids not in items\.json: ghost, phantom/,
    );
  });
});

describe('loadWeeks', () => {
  it('returns the weeks oldest first, whatever the folder order', async () => {
    await writeWeek(root(), WEEK_41, '2026-10-07T09:00:00Z');
    await writeWeek(root(), WEEK_40, '2026-09-30T09:00:00Z');

    const weeks = await loadWeeks(weeksDir());

    expect(weeks.map((week) => week.weekId)).toEqual([WEEK_40, WEEK_41]);
  });

  it('skips folders that are not ISO week ids', async () => {
    await writeWeek(root(), WEEK_40, '2026-09-30T09:00:00Z');
    await writeJson(root(), 'weeks/notes/items.json', 'x');
    await writeJson(root(), 'weeks/2026-W54/items.json', 'x');

    const weeks = await loadWeeks(weeksDir());

    expect(weeks.map((week) => week.weekId)).toEqual([WEEK_40]);
  });

  it('is empty when the weeks folder does not exist', async () => {
    expect(await loadWeeks(weeksDir())).toEqual([]);
  });
});
