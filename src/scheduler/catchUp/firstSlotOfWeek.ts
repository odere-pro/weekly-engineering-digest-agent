import { compareWeekIds, isoWeekId, weekStartUtc } from '../../shared/isoWeek';
import { HOUR_MS } from '../timing';

/** The furthest a time zone's local Monday 00:00 can lie before Monday 00:00 UTC (UTC+14). */
export const MAX_UTC_OFFSET_MS = 14 * HOUR_MS;

/** The part of a cron job this folder reads; croner's `Cron` satisfies it. */
export interface SlotSource {
  nextRun(from?: Date): Date | null;
}

/** The first fire inside the local ISO week `weekId`, or null when the cron never fires again. */
export function firstSlotOfWeek(job: SlotSource, weekId: string, timeZone: string): Date | null {
  // Local Monday 00:00 is never earlier than this. nextRun() is strictly after its argument,
  // so start 1 ms early to keep a fire at exactly local midnight (UTC+14) in reach.
  const from = new Date(weekStartUtc(weekId).getTime() - MAX_UTC_OFFSET_MS - 1);
  let slot = job.nextRun(from);
  while (slot !== null && compareWeekIds(isoWeekId(slot, timeZone), weekId) < 0) {
    slot = job.nextRun(slot);
  }
  return slot;
}
