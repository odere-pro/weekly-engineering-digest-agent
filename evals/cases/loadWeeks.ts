import { join } from 'node:path';
import { z } from 'zod';
import { ItemSchema, WEEK_ID_PATTERN } from '../../src/domain/schemas';
import { DigestError } from '../../src/shared/errors';
import { compareWeekIds, isoWeekId } from '../../src/shared/isoWeek';
import { WeekLabelsSchema } from '../schema';
import type { EvalWeek } from './evalSet';
import { listNames, requireJson } from './jsonFiles';

/** One week folder: its items, and labels that name only items the week has. */
export async function loadWeek(weeksDir: string, weekId: string): Promise<EvalWeek> {
  const dir = join(weeksDir, weekId);
  const itemsPath = join(dir, 'items.json');
  const items = await requireJson(itemsPath, z.array(ItemSchema));
  const stray = items.filter((item) => isoWeekId(new Date(item.publishedAt)) !== weekId);
  if (stray.length > 0) {
    throw new DigestError(
      `${itemsPath}: ${stray.length} item(s) were not published in ${weekId}, for example ${stray[0]?.id}`,
    );
  }
  const labelsPath = join(dir, 'labels.json');
  const labels = await requireJson(labelsPath, WeekLabelsSchema);
  const known = new Set(items.map((item) => item.id));
  const unknown = [...labels.mustInclude, ...labels.mustExclude].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new DigestError(`${labelsPath}: ids not in items.json: ${unknown.join(', ')}`);
  }
  return { weekId, items, labels };
}

/** Every folder of `weeksDir` named like an ISO week, oldest first. Other folders are ignored. */
export async function loadWeeks(weeksDir: string): Promise<EvalWeek[]> {
  const weekIds = (await listNames(weeksDir))
    .filter((name) => WEEK_ID_PATTERN.test(name))
    .sort(compareWeekIds);
  const weeks: EvalWeek[] = [];
  for (const weekId of weekIds) weeks.push(await loadWeek(weeksDir, weekId));
  return weeks;
}
