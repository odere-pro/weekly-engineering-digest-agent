import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Item } from '../../../src/domain/schemas';
import type { WeekRecord } from '../types';
import { mergeItems, readRecordedItems } from './recordedItems';
import { renderCandidates } from './renderCandidates';
import { formatLikeRepo, toJson, writeIfAbsent } from './writeFiles';

/** The empty `labels.json` a new week starts with; the maintainer fills it in by hand. */
export const LABELS_TEMPLATE = { mustInclude: [], mustExclude: [], notes: '' };

/**
 * Writes one week's folder. `items.json` only grows (see `mergeItems`), `labels.json` is created
 * once and never touched again, `candidates.md` is derived and rewritten every time.
 */
export async function recordWeek(
  weekDir: string,
  weekId: string,
  collected: readonly Item[],
): Promise<WeekRecord> {
  await mkdir(weekDir, { recursive: true });
  const itemsPath = join(weekDir, 'items.json');
  const recorded = await readRecordedItems(itemsPath);
  const items = mergeItems(recorded ?? [], collected);
  if (recorded === undefined || items.length > recorded.length) {
    await writeFile(itemsPath, await toJson(itemsPath, items));
  }

  const labelsPath = join(weekDir, 'labels.json');
  await writeIfAbsent(labelsPath, await toJson(labelsPath, LABELS_TEMPLATE));

  // Derived from items.json, so it is rewritten every time and never disagrees with it.
  const candidatesPath = join(weekDir, 'candidates.md');
  await writeFile(
    candidatesPath,
    await formatLikeRepo(candidatesPath, renderCandidates(weekId, items)),
  );
  return { weekId, items, alreadyRecorded: recorded?.length };
}
