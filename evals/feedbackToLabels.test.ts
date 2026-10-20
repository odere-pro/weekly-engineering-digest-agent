import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackToLabels } from './feedbackToLabels';
import { makeItem } from '../test/builders';
import { weekDigestDir } from '../src/store/layout';

const WEEK = '2026-W42';
let root: string;
let lines: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'feedback-labels-'));
  lines = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const paths = () => ({
  feedback: join(root, 'data', 'feedback', `${WEEK}.json`),
  runItems: join(weekDigestDir(join(root, 'data'), WEEK), 'items.json'),
  weekDir: join(root, 'evals', 'weeks', WEEK),
  labels: join(root, 'evals', 'weeks', WEEK, 'labels.json'),
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

const run = () =>
  feedbackToLabels(
    { week: WEEK, dataDir: join(root, 'data'), evalsDir: join(root, 'evals') },
    { log: (line) => lines.push(line) },
  );
const labels = async (): Promise<unknown> => JSON.parse(await readFile(paths().labels, 'utf8'));

describe('feedbackToLabels', () => {
  it('adds missed items as must-include and wrong picks as must-exclude', async () => {
    const p = paths();
    await put(p.feedback, { weekId: WEEK, wrongPicks: ['w1'], missed: ['m1', 'm2'] });
    await put(p.labels, { mustInclude: ['a'], mustExclude: ['b'], notes: 'kept' });

    const result = await run();

    expect(await labels()).toEqual({
      mustInclude: ['a', 'm1', 'm2'],
      mustExclude: ['b', 'w1'],
      notes: 'kept',
    });
    expect(result).toEqual({ added: 3, conflicts: [], createdWeek: false });
  });

  it('leaves labels that already agree alone', async () => {
    const p = paths();
    await put(p.feedback, { weekId: WEEK, wrongPicks: ['b'], missed: ['a'] });
    await put(p.labels, { mustInclude: ['a'], mustExclude: ['b'] });

    const result = await run();

    expect(await labels()).toEqual({ mustInclude: ['a'], mustExclude: ['b'] });
    expect(result.added).toBe(0);
  });

  it('prints to the console when no log function is given', async () => {
    const p = paths();
    await put(p.feedback, { weekId: WEEK, wrongPicks: ['a'], missed: [] });
    await put(p.labels, { mustInclude: ['a'], mustExclude: [] });
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await feedbackToLabels({
      week: WEEK,
      dataDir: join(root, 'data'),
      evalsDir: join(root, 'evals'),
    });

    expect(printed).toHaveBeenCalledWith(expect.stringContaining('CONFLICT a'));
  });

  it('refuses to overwrite a label and prints the conflict', async () => {
    const p = paths();
    await put(p.feedback, { weekId: WEEK, wrongPicks: ['a'], missed: ['b', 'c'] });
    await put(p.labels, { mustInclude: ['a'], mustExclude: ['b'] });

    const result = await run();

    expect(await labels()).toEqual({ mustInclude: ['a', 'c'], mustExclude: ['b'] });
    expect(result.conflicts).toEqual([
      'b: feedback says missed, but labels say must-exclude',
      'a: feedback says wrong pick, but labels say must-include',
    ]);
    expect(lines.join('\n')).toContain('CONFLICT a');
    expect(lines.join('\n')).toContain('CONFLICT b');
  });

  it('creates the week folder from the run items when it is missing', async () => {
    const p = paths();
    const items = [makeItem({ id: 'm1' }), makeItem({ id: 'w1' })];
    await put(p.feedback, { weekId: WEEK, wrongPicks: ['w1'], missed: ['m1'] });
    await put(p.runItems, items);

    const result = await run();

    expect(JSON.parse(await readFile(join(p.weekDir, 'items.json'), 'utf8'))).toEqual(items);
    expect(await labels()).toEqual({ mustInclude: ['m1'], mustExclude: ['w1'], notes: '' });
    expect(result.createdWeek).toBe(true);
  });

  it('keeps recorded items when the week folder exists without labels', async () => {
    const p = paths();
    await put(p.feedback, { weekId: WEEK, wrongPicks: [], missed: ['m1'] });
    await put(join(p.weekDir, 'items.json'), [makeItem({ id: 'recorded' })]);

    await run();

    expect(JSON.parse(await readFile(join(p.weekDir, 'items.json'), 'utf8'))).toHaveLength(1);
    expect(await labels()).toMatchObject({ mustInclude: ['m1'] });
  });

  it('warns when must-include is no longer the 5 that digest eval expects', async () => {
    const p = paths();
    await put(p.feedback, { weekId: WEEK, wrongPicks: [], missed: ['m1'] });
    await put(p.labels, { mustInclude: ['a', 'b', 'c', 'd', 'e'], mustExclude: [] });

    await run();

    expect(lines.join('\n')).toMatch(/6 must-include.*exactly 5/);
  });

  it('fails when the feedback file is missing, broken or for another week', async () => {
    await expect(run()).rejects.toThrow(/digest feedback/);

    await put(paths().feedback, { weekId: 'x' });
    await expect(run()).rejects.toThrow(/feedback/);

    await put(paths().feedback, { weekId: '2026-W41', wrongPicks: [], missed: [] });
    await expect(run()).rejects.toThrow(/2026-W41/);
  });

  it('fails when a new week has no run items to copy', async () => {
    await put(paths().feedback, { weekId: WEEK, wrongPicks: [], missed: [] });

    await expect(run()).rejects.toThrow(/items\.json/);
  });

  it('fails on a labels file it cannot read', async () => {
    const p = paths();
    await put(p.feedback, { weekId: WEEK, wrongPicks: [], missed: [] });
    await put(p.labels, { mustInclude: 'nope' });

    await expect(run()).rejects.toThrow(/labels\.json/);
  });

  it('rejects a week that is not an ISO week id', async () => {
    await expect(
      feedbackToLabels({
        week: '../x',
        dataDir: join(root, 'data'),
        evalsDir: join(root, 'evals'),
      }),
    ).rejects.toThrow(/ISO week/);
  });
});
