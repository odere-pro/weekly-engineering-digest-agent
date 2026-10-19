import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEvalCases } from './loadEvalCases';
import {
  WEEK_40,
  WEEK_41,
  useCasesDir,
  weekItems,
  writeJson,
  writeStandardWeeks,
  writeWeek,
} from '../evalKit';
import { ExitCode } from '../../src/domain/schemas';
import { DigestError } from '../../src/shared/errors';
import { makeDraft, makeItem } from '../../test/builders';

const AREA_A = 'AI models and tooling';
const root = useCasesDir();

describe('loadEvalCases', () => {
  it('returns an empty set for an empty directory', async () => {
    const cases = await loadEvalCases(root());
    expect(cases).toEqual({
      weeks: [],
      classifier: { reviewed: false, cases: [] },
      attacks: [],
      grounding: [],
      calibration: null,
      sources: [],
    });
  });

  it('loads weeks in order, and every kind of case', async () => {
    await writeWeek(root(), WEEK_41, '2026-10-07T09:00:00Z', {
      include: [1, 2, 3, 4, 5],
      exclude: [],
    });
    await writeWeek(root(), WEEK_40, '2026-09-30T09:00:00Z', {
      include: [1, 2, 3, 4, 5],
      exclude: [],
    });
    await writeJson(root(), 'classifier-cases.json', {
      reviewed: true,
      cases: [{ item: makeItem(), expected: { area: AREA_A, relevance: 2 } }],
    });
    await writeJson(root(), 'attacks/a1.json', { id: 'a1', item: makeItem(), kind: 'injection' });
    const items = [makeItem(), makeItem()];
    await writeJson(root(), 'grounding/g1.json', {
      id: 'g1',
      draft: makeDraft(items),
      sources: items,
      plantedItemId: items[0]!.id,
    });
    await writeJson(root(), 'judge/calibration.json', {
      judgeAgreement: 0.9,
      selectionAgreement: 0.8,
    });
    await writeFile(join(root(), 'attacks', 'README.md'), 'ignored');

    const cases = await loadEvalCases(root());

    expect(cases.weeks.map((w) => w.weekId)).toEqual([WEEK_40, WEEK_41]);
    expect(cases.classifier.reviewed).toBe(true);
    expect(cases.classifier.cases).toHaveLength(1);
    expect(cases.attacks.map((a) => a.id)).toEqual(['a1']);
    expect(cases.grounding.map((g) => g.id)).toEqual(['g1']);
    expect(cases.calibration).toEqual({ judgeAgreement: 0.9, selectionAgreement: 0.8 });
  });

  it('ignores folders that are not week ids', async () => {
    await writeJson(root(), 'weeks/notes/items.json', 'x');
    expect((await loadEvalCases(root())).weeks).toEqual([]);
  });

  it('names the file when labels do not parse', async () => {
    await writeJson(root(), `weeks/${WEEK_40}/items.json`, weekItems('2026-09-30T09:00:00Z', 'x'));
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, { mustInclude: [], mustExclude: [] });
    await expect(loadEvalCases(root())).rejects.toThrow(/labels\.json/);
    await expect(loadEvalCases(root())).rejects.toBeInstanceOf(DigestError);
  });

  it('names the file when items.json is missing', async () => {
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, {
      mustInclude: ['a', 'b', 'c', 'd', 'e'],
    });
    await expect(loadEvalCases(root())).rejects.toThrow(/items\.json/);
  });

  it('rejects labels that name an item the week does not have', async () => {
    await writeJson(root(), `weeks/${WEEK_40}/items.json`, weekItems('2026-09-30T09:00:00Z', 'x'));
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, {
      mustInclude: ['a', 'b', 'c', 'd', 'e'],
    });
    await expect(loadEvalCases(root())).rejects.toThrow(/not in items\.json/);
  });

  it('names the file when a case is not valid JSON', async () => {
    await mkdir(join(root(), 'attacks'));
    await writeFile(join(root(), 'attacks', 'bad.json'), '{ nope');
    await expect(loadEvalCases(root())).rejects.toThrow(/bad\.json.*JSON/);
  });

  it('rejects duplicate case ids', async () => {
    await writeJson(root(), 'attacks/a.json', { id: 'same', item: makeItem(), kind: 'k' });
    await writeJson(root(), 'attacks/b.json', { id: 'same', item: makeItem(), kind: 'k' });
    await expect(loadEvalCases(root())).rejects.toThrow(/duplicate attack id "same"/);
  });

  it('rejects two attack cases that share an item id', async () => {
    const item = makeItem();
    await writeJson(root(), 'attacks/a1.json', { id: 'a1', item, kind: 'k' });
    await writeJson(root(), 'attacks/a2.json', {
      id: 'a2',
      item: { ...makeItem(), id: item.id },
      kind: 'k',
    });
    await expect(loadEvalCases(root())).rejects.toThrow(/attack a2 shares its id with attack a1/);
  });

  it('rejects an attack case that shares its URL with a recorded item', async () => {
    const [w40] = await writeStandardWeeks(root());
    const taken = w40[0]!;
    await writeJson(root(), 'attacks/a1.json', {
      id: 'a1',
      item: { ...makeItem(), url: taken.url },
      kind: 'k',
    });
    await expect(loadEvalCases(root())).rejects.toThrow(/attack a1 shares its URL with 2026-W40/);
  });

  it('rejects an item that was not published in its week', async () => {
    const items = [makeItem({ publishedAt: '2026-10-20T09:00:00Z' })];
    await writeJson(root(), `weeks/${WEEK_40}/items.json`, items);
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, {
      mustInclude: ['a', 'b', 'c', 'd', 'e'],
    });
    await expect(loadEvalCases(root())).rejects.toThrow(
      /1 item\(s\) were not published in 2026-W40/,
    );
  });

  describe('a cases folder that does not exist', () => {
    const missing = (): string => join(root(), 'evals');

    it('rejects with a DigestError that names the folder', async () => {
      await expect(loadEvalCases(missing())).rejects.toBeInstanceOf(DigestError);
      await expect(loadEvalCases(missing())).rejects.toThrow(`Eval folder ${missing()}: not found`);
    });

    it('says that digest eval needs a clone, because the npm package has no evals folder', async () => {
      const error = await loadEvalCases(missing()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DigestError);
      const { message } = error as DigestError;
      expect(message).toContain(
        '"digest eval" needs the evals/ folder of a clone of the repository',
      );
      expect(message).toContain('npm package');
    });

    it('keeps the generic exit code', async () => {
      const error = await loadEvalCases(missing()).catch((caught: unknown) => caught);

      expect((error as DigestError).exitCode).toBe(ExitCode.Failed);
    });
  });

  describe('an existing folder that lacks a sub-folder', () => {
    it('is an empty set for every part, not an error', async () => {
      await mkdir(join(root(), 'weeks'));

      const cases = await loadEvalCases(root());

      expect(cases.weeks).toEqual([]);
      expect(cases.attacks).toEqual([]);
      expect(cases.grounding).toEqual([]);
      expect(cases.sources).toEqual([]);
    });

    it('does not mention a clone when a file inside it is bad', async () => {
      await mkdir(join(root(), 'attacks'));
      await writeFile(join(root(), 'attacks', 'bad.json'), '{ nope');

      const error = await loadEvalCases(root()).catch((caught: unknown) => caught);

      expect((error as DigestError).message).not.toContain('clone');
    });
  });
});
