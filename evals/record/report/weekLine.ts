import { pluralizeItems } from '../display';
import type { WeekRecord } from '../types';

/** Weeks with fewer items are hard to label; feeds often keep only 10-20 entries. */
export const THIN_WEEK_MIN_ITEMS = 10;

const COUNT_WIDTH = 8;

/** One report line for a week: its id and item count, a thin-week warning, what was added. */
export function weekLine(record: WeekRecord): string {
  const count = pluralizeItems(record.items.length).padStart(COUNT_WIDTH);
  const notes = [
    record.items.length < THIN_WEEK_MIN_ITEMS
      ? `WARNING: fewer than ${THIN_WEEK_MIN_ITEMS} items; feeds often keep only 10-20 entries`
      : undefined,
    record.alreadyRecorded === undefined
      ? undefined
      : `${record.alreadyRecorded} already recorded, ${record.items.length - record.alreadyRecorded} added`,
  ].filter((note) => note !== undefined);
  return `  ${record.weekId}  ${count}${notes.length > 0 ? `  ${notes.join('; ')}` : ''}`;
}
