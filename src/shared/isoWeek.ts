import { WEEK_ID_PATTERN } from '../core/schemas.js';

const DAY_MS = 86_400_000;

/** Calendar date (y, m, d) of `date` in `timeZone`. */
function localDate(date: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** ISO 8601 week id, e.g. "2026-W43", of `date` as seen in `timeZone`. */
export function isoWeekId(date: Date, timeZone = 'UTC'): string {
  const { y, m, d } = localDate(date, timeZone);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = utc.getUTCDay() || 7;
  // Thursday of this week decides the ISO year.
  utc.setUTCDate(utc.getUTCDate() + 4 - dayOfWeek);
  const isoYear = utc.getUTCFullYear();
  const week = Math.ceil(((utc.getTime() - Date.UTC(isoYear, 0, 1)) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function parseWeekId(weekId: string): { year: number; week: number } {
  if (!WEEK_ID_PATTERN.test(weekId)) throw new Error(`Invalid ISO week id: ${weekId}`);
  const [year, week] = weekId.split('-W').map(Number) as [number, number];
  return { year, week };
}

/** Monday 00:00 UTC of the ISO week. */
export function weekStartUtc(weekId: string): Date {
  const { year, week } = parseWeekId(weekId);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = jan4.getTime() - (jan4Day - 1) * DAY_MS;
  return new Date(mondayWeek1 + (week - 1) * 7 * DAY_MS);
}

/** The `count` week ids before `weekId`, most recent first. */
export function previousWeekIds(weekId: string, count: number): string[] {
  const start = weekStartUtc(weekId).getTime();
  return Array.from({ length: count }, (_, i) => isoWeekId(new Date(start - (i + 1) * 7 * DAY_MS)));
}

/** Negative when a is earlier than b. */
export function compareWeekIds(a: string, b: string): number {
  return weekStartUtc(a).getTime() - weekStartUtc(b).getTime();
}
