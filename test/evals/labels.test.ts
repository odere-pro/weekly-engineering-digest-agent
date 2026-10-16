// The maintainer's labels for the six recorded weeks (W3-01): 5 must-include items per week
// and any must-exclude items. They are the ground truth for the recall and leak metrics.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_EVAL_SET, loadEvalCases } from '../../evals/runEval.js';
import { MUST_INCLUDE_COUNT, WeekLabelsSchema, type WeekLabels } from '../../evals/schema.js';
import { ItemSchema, type Item } from '../../src/core/schemas.js';

const RECORDED_WEEKS = [
  '2026-W36',
  '2026-W37',
  '2026-W38',
  '2026-W39',
  '2026-W40',
  '2026-W41',
] as const;
/** Set only after the maintainer has gone through a week's proposal. */
const REVIEWED_NOTE = /^agent-proposed, maintainer-reviewed \d{4}-\d{2}-\d{2}$/;

const evalsDir = join(import.meta.dirname, '..', '..', 'evals');

async function readJson(week: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(evalsDir, 'weeks', week, file), 'utf8'));
}

async function readLabels(week: string): Promise<WeekLabels> {
  const parsed = WeekLabelsSchema.safeParse(await readJson(week, 'labels.json'));
  if (!parsed.success) throw new Error(`${week}/labels.json: ${parsed.error.message}`);
  return parsed.data;
}

async function readItems(week: string): Promise<Item[]> {
  return ItemSchema.array().parse(await readJson(week, 'items.json'));
}

describe('recorded week labels', () => {
  it('loads through the eval harness for every week the spec asks for', async () => {
    const { weeks } = await loadEvalCases(evalsDir);

    expect(weeks.map((week) => week.weekId)).toEqual([...RECORDED_WEEKS]);
    expect(weeks).toHaveLength(SPEC_EVAL_SET.weeks);
  });

  describe.each(RECORDED_WEEKS)('%s', (week) => {
    it('parses with WeekLabelsSchema and names exactly 5 must-include items', async () => {
      const labels = await readLabels(week);

      expect(labels.mustInclude).toHaveLength(MUST_INCLUDE_COUNT);
    });

    it('names only ids that exist in items.json', async () => {
      const labels = await readLabels(week);
      const known = new Set((await readItems(week)).map((item) => item.id));

      const unknown = [...labels.mustInclude, ...labels.mustExclude].filter((id) => !known.has(id));

      expect(unknown).toEqual([]);
    });

    it('lists no must-exclude id twice', async () => {
      const { mustExclude } = await readLabels(week);

      expect(new Set(mustExclude).size).toBe(mustExclude.length);
    });

    it('records that the maintainer reviewed the labels', async () => {
      const { notes } = await readLabels(week);

      expect(notes).toMatch(REVIEWED_NOTE);
    });
  });
});
