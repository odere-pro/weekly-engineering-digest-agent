import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DigestError } from '../../../src/shared/errors';
import { itemAt } from '../__fixtures__/recordKit';
import { LABELS_TEMPLATE, recordWeek } from './recordWeek';

let root = '';
let weekDir = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'record-week-'));
  weekDir = join(root, '2021-W02');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (name: string): Promise<string> => readFile(join(weekDir, name), 'utf8');
const readItemIds = async (): Promise<string[]> =>
  (JSON.parse(await read('items.json')) as { id: string }[]).map((item) => item.id);

describe('recordWeek', () => {
  it('creates the week folder with items.json, labels.json and candidates.md', async () => {
    const item = itemAt('2021-01-12T10:00:00Z', { id: 'one', title: 'Only item' });

    await recordWeek(weekDir, '2021-W02', [item]);

    expect(await readItemIds()).toEqual(['one']);
    expect(JSON.parse(await read('labels.json'))).toEqual(LABELS_TEMPLATE);
    expect(await read('candidates.md')).toContain('1. **Only item**');
  });

  it('reports the items and, on a first run, no earlier recording', async () => {
    const item = itemAt('2021-01-12T10:00:00Z', { id: 'one' });

    const record = await recordWeek(weekDir, '2021-W02', [item]);

    expect(record).toEqual({ weekId: '2021-W02', items: [item], alreadyRecorded: undefined });
  });

  it('records a week without items as an empty list and an empty candidates page', async () => {
    const record = await recordWeek(weekDir, '2021-W02', []);

    expect(record.items).toEqual([]);
    expect(await readItemIds()).toEqual([]);
    expect(await read('candidates.md')).toContain('No items were recorded for this week.');
  });

  it('keeps recorded items, adds new ones and counts what was already there', async () => {
    await recordWeek(weekDir, '2021-W02', [itemAt('2021-01-12T10:00:00Z', { id: 'old' })]);

    const record = await recordWeek(weekDir, '2021-W02', [
      itemAt('2021-01-13T10:00:00Z', { id: 'new' }),
    ]);

    expect(await readItemIds()).toEqual(['new', 'old']);
    expect(record.alreadyRecorded).toBe(1);
    expect(record.items.map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('does not rewrite items.json when a re-run finds nothing new', async () => {
    const recorded = itemAt('2021-01-12T10:00:00Z', { id: 'old', title: 'Old title' });
    await mkdir(weekDir, { recursive: true });
    const original = JSON.stringify([recorded]); // not the repo format, so a rewrite shows
    await writeFile(join(weekDir, 'items.json'), original);

    const record = await recordWeek(weekDir, '2021-W02', [{ ...recorded, title: 'Edited' }]);

    expect(await read('items.json')).toBe(original);
    expect(record.alreadyRecorded).toBe(1);
  });

  it('never overwrites an existing labels.json', async () => {
    const labels = '{"mustInclude":["abc"],"mustExclude":[],"notes":"hand written"}\n';
    await mkdir(weekDir, { recursive: true });
    await writeFile(join(weekDir, 'labels.json'), labels);

    await recordWeek(weekDir, '2021-W02', [itemAt('2021-01-12T10:00:00Z')]);
    await recordWeek(weekDir, '2021-W02', [itemAt('2021-01-13T10:00:00Z')]);

    expect(await read('labels.json')).toBe(labels);
  });

  it('leaves any other file in the week folder alone', async () => {
    await mkdir(weekDir, { recursive: true });
    await writeFile(join(weekDir, 'expected.json'), 'by hand');

    await recordWeek(weekDir, '2021-W02', [itemAt('2021-01-12T10:00:00Z')]);

    expect(await read('expected.json')).toBe('by hand');
  });

  it('rewrites candidates.md every run, so it never disagrees with items.json', async () => {
    await mkdir(weekDir, { recursive: true });
    await writeFile(join(weekDir, 'candidates.md'), 'stale');

    await recordWeek(weekDir, '2021-W02', [itemAt('2021-01-12T10:00:00Z', { title: 'Fresh' })]);

    expect(await read('candidates.md')).toContain('Fresh');
    expect(await read('candidates.md')).not.toContain('stale');
  });

  it('refuses an items.json that is not a list of items and writes nothing else', async () => {
    await mkdir(weekDir, { recursive: true });
    await writeFile(join(weekDir, 'items.json'), '{"not":"a list"}');

    await expect(recordWeek(weekDir, '2021-W02', [])).rejects.toBeInstanceOf(DigestError);
    await expect(stat(join(weekDir, 'labels.json'))).rejects.toThrow(/ENOENT/);
  });
});
