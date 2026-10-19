import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DigestError } from '../../src/shared/errors';
import { makeItem } from '../../test/builders';
import { WEEK_40, useCasesDir, writeJson } from '../evalKit';
import type { AttackCase } from '../schema';
import { assertAttacksAreDistinct, loadCaseDir } from './caseFiles';
import type { EvalWeek } from './evalSet';

const root = useCasesDir();
const CaseSchema = z.object({ id: z.string() });

describe('loadCaseDir', () => {
  it('loads the JSON files in name order and ignores other files', async () => {
    await writeJson(root(), 'cases/b.json', { id: 'b' });
    await writeJson(root(), 'cases/a.json', { id: 'a' });
    await writeFile(join(root(), 'cases', 'README.md'), 'ignored');

    const cases = await loadCaseDir(join(root(), 'cases'), CaseSchema, 'demo');

    expect(cases.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('is empty when the folder does not exist', async () => {
    expect(await loadCaseDir(join(root(), 'cases'), CaseSchema, 'demo')).toEqual([]);
  });

  it('names the kind and the id when two files share an id', async () => {
    await writeJson(root(), 'cases/a.json', { id: 'same' });
    await writeJson(root(), 'cases/b.json', { id: 'same' });

    await expect(loadCaseDir(join(root(), 'cases'), CaseSchema, 'demo')).rejects.toThrow(
      /duplicate demo id "same"/,
    );
  });

  it('names the file when a case does not match the schema', async () => {
    await writeJson(root(), 'cases/a.json', { id: 7 });

    await expect(loadCaseDir(join(root(), 'cases'), CaseSchema, 'demo')).rejects.toThrow(
      /a\.json does not match its schema/,
    );
  });
});

describe('assertAttacksAreDistinct', () => {
  const week = (...items: ReturnType<typeof makeItem>[]): EvalWeek => ({
    weekId: WEEK_40,
    items,
    labels: { mustInclude: [], mustExclude: [] },
  });
  const attack = (id: string, item: ReturnType<typeof makeItem>): AttackCase => ({
    id,
    kind: 'k',
    item,
  });

  it('accepts attacks that share nothing with the weeks or each other', () => {
    expect(() => {
      assertAttacksAreDistinct(
        [attack('a1', makeItem()), attack('a2', makeItem())],
        [week(makeItem())],
      );
    }).not.toThrow();
  });

  it('rejects an attack whose item id is in a recorded week', () => {
    const taken = makeItem();

    expect(() => {
      assertAttacksAreDistinct([attack('a1', { ...makeItem(), id: taken.id })], [week(taken)]);
    }).toThrow(new DigestError(`attack a1 shares its id with ${WEEK_40}`));
  });

  it('rejects an attack whose URL is in a recorded week, even spelled differently', () => {
    const taken = makeItem({ url: 'https://example.com/post' });
    const spelled = { ...makeItem(), url: 'https://EXAMPLE.com/post/' };

    expect(() => {
      assertAttacksAreDistinct([attack('a1', spelled)], [week(taken)]);
    }).toThrow(`attack a1 shares its URL with ${WEEK_40}`);
  });

  it('rejects two attacks that share an item id and names the first', () => {
    const first = makeItem();

    expect(() => {
      assertAttacksAreDistinct(
        [attack('a1', first), attack('a2', { ...makeItem(), id: first.id })],
        [],
      );
    }).toThrow('attack a2 shares its id with attack a1');
  });
});
