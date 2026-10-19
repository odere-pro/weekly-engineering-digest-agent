import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DigestError } from '../../../src/shared/errors';
import { itemAt } from '../__fixtures__/recordKit';
import { mergeItems, readRecordedItems } from './recordedItems';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recorded-items-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readRecordedItems', () => {
  it('is undefined when there is no items.json yet', async () => {
    expect(await readRecordedItems(join(dir, 'items.json'))).toBeUndefined();
  });

  it('returns the items of an earlier run', async () => {
    const items = [itemAt('2021-01-12T10:00:00Z'), itemAt('2021-01-11T10:00:00Z')];
    await writeFile(join(dir, 'items.json'), JSON.stringify(items));

    expect(await readRecordedItems(join(dir, 'items.json'))).toEqual(items);
  });

  it('returns an empty list for a file with an empty list', async () => {
    await writeFile(join(dir, 'items.json'), '[]');

    expect(await readRecordedItems(join(dir, 'items.json'))).toEqual([]);
  });

  it('names the file and how to fix it when it is not a list of items', async () => {
    const path = join(dir, 'items.json');
    await writeFile(path, '{"not":"a list"}');

    const failure = readRecordedItems(path);

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow(`Cannot reuse ${path}:`);
    await expect(failure).rejects.toThrow('Fix it or delete it to record again.');
  });

  it('names the file when it is not JSON', async () => {
    const path = join(dir, 'items.json');
    await writeFile(path, '[ not json');

    await expect(readRecordedItems(path)).rejects.toThrow(/Cannot reuse .*items\.json/);
  });

  it('lets any other read error through instead of treating the file as missing', async () => {
    const path = join(dir, 'items.json');
    await mkdir(path); // a folder where the file should be: EISDIR

    await expect(readRecordedItems(path)).rejects.toThrow(/EISDIR/);
  });
});

describe('mergeItems', () => {
  it('keeps recorded items as they are, even when the feed edited them since', () => {
    const recorded = itemAt('2021-01-12T10:00:00Z', { id: 'one', title: 'Old title' });
    const collected = { ...recorded, title: 'Edited upstream' };

    expect(mergeItems([recorded], [collected])).toEqual([recorded]);
  });

  it('adds the collected items that are not recorded yet', () => {
    const recorded = itemAt('2021-01-12T10:00:00Z', { id: 'one' });
    const added = itemAt('2021-01-13T10:00:00Z', { id: 'two' });

    expect(mergeItems([recorded], [recorded, added]).map((item) => item.id)).toEqual([
      'two',
      'one',
    ]);
  });

  it('sorts newest first, whatever the order of the inputs', () => {
    const old = itemAt('2021-01-11T10:00:00Z', { id: 'old' });
    const mid = itemAt('2021-01-12T10:00:00Z', { id: 'mid' });
    const recent = itemAt('2021-01-13T10:00:00Z', { id: 'recent' });

    expect(mergeItems([old, recent], [mid]).map((item) => item.id)).toEqual([
      'recent',
      'mid',
      'old',
    ]);
  });

  it('keeps a recorded item the feeds no longer serve', () => {
    const gone = itemAt('2021-01-12T10:00:00Z', { id: 'gone', sourceId: 'retired-feed' });

    expect(mergeItems([gone], [])).toEqual([gone]);
  });

  it('is empty when nothing is recorded or collected', () => {
    expect(mergeItems([], [])).toEqual([]);
  });

  it('returns a new list and leaves both inputs alone', () => {
    const recorded = [itemAt('2021-01-11T10:00:00Z', { id: 'a' })];
    const collected = [itemAt('2021-01-13T10:00:00Z', { id: 'b' })];

    const merged = mergeItems(recorded, collected);

    expect(merged).not.toBe(recorded);
    expect(recorded.map((item) => item.id)).toEqual(['a']);
    expect(collected.map((item) => item.id)).toEqual(['b']);
  });
});
