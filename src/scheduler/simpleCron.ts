import { DigestError, errorMessage } from '../shared/errors.js';

/** The only cron shape the OS schedulers can express here: "m h * * dow". */
export interface SimpleCron {
  /** 0-59. */
  minute: number;
  /** 0-23. */
  hour: number;
  /** ISO weekdays, 1 = Monday .. 7 = Sunday, sorted and unique. Null means every day. */
  weekdays: readonly number[] | null;
}

const FIELD_COUNT = 5;
const MAX_MINUTE = 59;
const MAX_HOUR = 23;
/** Cron counts Sunday as 0 and as 7. */
const MAX_CRON_WEEKDAY = 7;
const SUNDAY_ISO = 7;
/** Cron weekday names by cron number (0 = Sunday). */
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const INTEGER = /^\d+$/;
const FALLBACK_HINT =
  'Use "m h * * dow", for example "45 7 * * 1", or run "digest run" from your own scheduler.';

/** Parses `m h * * dow` (single minute and hour; weekday star, number, name, list or range). */
export function parseSimpleCron(cron: string): SimpleCron {
  try {
    return parseFields(cron.trim().split(/\s+/));
  } catch (cause) {
    throw new DigestError(
      `Cannot turn cron "${cron.trim()}" into an OS schedule: ${errorMessage(cause)}. ${FALLBACK_HINT}`,
      { cause },
    );
  }
}

function parseFields(fields: readonly string[]): SimpleCron {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    fields.length !== FIELD_COUNT ||
    minute === undefined ||
    hour === undefined ||
    dayOfWeek === undefined
  ) {
    throw new Error(`expected ${FIELD_COUNT} fields, found ${fields.length}`);
  }
  if (dayOfMonth !== '*' || month !== '*') {
    throw new Error('day of month and month must be "*"');
  }
  return {
    minute: parseNumber(minute, 'minute', MAX_MINUTE),
    hour: parseNumber(hour, 'hour', MAX_HOUR),
    weekdays: dayOfWeek === '*' ? null : parseWeekdays(dayOfWeek),
  };
}

function parseNumber(field: string, label: string, max: number): number {
  const value = INTEGER.test(field) ? Number(field) : NaN;
  if (!(value <= max)) throw new Error(`${label} must be a single number from 0 to ${max}`);
  return value;
}

function parseWeekdays(field: string): number[] {
  const cronDays = field.split(',').flatMap(expandWeekdayPart);
  const isoDays = cronDays.map((day) => (day === 0 ? SUNDAY_ISO : day));
  return [...new Set(isoDays)].sort((a, b) => a - b);
}

/** One list item ("1", "mon", "1-5", "mon-fri") as cron weekday numbers. */
function expandWeekdayPart(part: string): number[] {
  const bounds = part.split('-');
  const [first, last] = bounds;
  if (first === undefined || bounds.length > 2) throw new Error(`unsupported weekday "${part}"`);
  const start = parseWeekday(first);
  const end = last === undefined ? start : parseWeekday(last);
  if (start > end) throw new Error(`weekday range "${part}" runs backwards`);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function parseWeekday(token: string): number {
  const named = WEEKDAY_NAMES.indexOf(token.toLowerCase());
  if (named >= 0) return named;
  const value = INTEGER.test(token) ? Number(token) : NaN;
  if (!(value <= MAX_CRON_WEEKDAY)) throw new Error(`unsupported weekday "${token}"`);
  return value;
}
