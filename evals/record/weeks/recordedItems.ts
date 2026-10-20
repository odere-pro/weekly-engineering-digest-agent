import { readFile } from 'node:fs/promises';
import { ItemSchema, type Item } from '../../../src/domain/schemas';
import { DigestError, errorMessage } from '../../../src/shared/errors';
import { errnoCode } from '../../../src/shared/fsErrors';

/** The items an earlier run recorded, undefined when there is no items.json yet. */
export async function readRecordedItems(path: string): Promise<Item[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return ItemSchema.array().parse(JSON.parse(raw));
  } catch (cause) {
    throw new DigestError(
      `Cannot reuse ${path}: ${errorMessage(cause)}. Fix it or delete it to record again.`,
      { cause },
    );
  }
}

/** Recorded items stay as they are; collected items not recorded yet are added, newest first. */
export function mergeItems(recorded: readonly Item[], collected: readonly Item[]): Item[] {
  const known = new Set(recorded.map((item) => item.id));
  const added = collected.filter((item) => !known.has(item.id));
  return [...recorded, ...added].toSorted(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}
