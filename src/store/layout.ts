// The dist/ layout: where every file the project produces goes, below the data folder
// (`config.dataDir`, default `dist`). Paths only, no file access.
//
//   <dataDir>/artifacts/                       the built CLI (scripts/build.mjs)
//   <dataDir>/logs/<day>/digest.log            log lines of that day
//   <dataDir>/<day>/digest/                    the week's run: run.json, digest.md, ...
//   <dataDir>/<day>/<sourceId>/raw/            what a source answered, as fetched
//   <dataDir>/<day>/<sourceId>/formatted/      the items it was read into
//
// A run's <day> is the Monday of its ISO week, whatever day it runs on, so a resumed or forced
// run finds the same folder. `digest fetch` uses the day it runs.
import { join } from 'node:path';
import { SourceSchema, WEEK_ID_PATTERN } from '../domain/schemas';
import { DigestError } from '../shared/errors';
import { isoWeekId, weekStartUtc } from '../shared/isoWeek';

export const DIGEST_DIR = 'digest';
export const LOGS_DIR = 'logs';
export const LOG_FILE = 'digest.log';
export const LOCK_FILE = 'digest.lock';

export type SourcePart = 'raw' | 'formatted';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_CHARS = 10;
const MONDAY = 1;
const SOURCE_ID = SourceSchema.shape.id;

/** One formatter per time zone: making one costs more than formatting a date with it. */
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of `date` in `timeZone`, as YYYY-MM-DD. Throws for an unknown zone. */
export function dayOf(date: Date, timeZone = 'UTC'): string {
  let format = dayFormats.get(timeZone);
  if (format === undefined) {
    // en-CA writes dates as YYYY-MM-DD.
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormats.set(timeZone, format);
  }
  return format.format(date);
}

/** The folder day of a week: its Monday. Refuses anything but an ISO week id. */
export function weekDay(weekId: string): string {
  // A W53 of a year with 52 weeks passes the pattern but starts on the next year's W01 Monday.
  const isRealWeek = WEEK_ID_PATTERN.test(weekId) && isoWeekId(weekStartUtc(weekId)) === weekId;
  if (!isRealWeek) {
    throw new DigestError(`Invalid run id "${weekId}": expected an ISO week like 2026-W43`);
  }
  return weekStartUtc(weekId).toISOString().slice(0, DAY_CHARS);
}

/** True for a day folder name, YYYY-MM-DD. */
export function isDayName(name: string): boolean {
  return DAY_PATTERN.test(name);
}

/** The week a Monday folder belongs to; undefined for any other folder name. */
export function weekOfDay(name: string): string | undefined {
  if (!DAY_PATTERN.test(name)) return undefined;
  const date = new Date(`${name}T00:00:00Z`);
  const isRealDay = !Number.isNaN(date.getTime()) && date.toISOString().startsWith(name);
  if (!isRealDay || date.getUTCDay() !== MONDAY) return undefined;
  return isoWeekId(date);
}

/** `<dataDir>/<monday>/digest`: the files of one week's run. */
export function weekDigestDir(dataDir: string, weekId: string): string {
  return join(dataDir, weekDay(weekId), DIGEST_DIR);
}

/** `<dataDir>/<day>/<sourceId>/<part>`: one source's raw answers or formatted items. */
export function sourceDir(
  dataDir: string,
  day: string,
  sourceId: string,
  part: SourcePart,
): string {
  if (!SOURCE_ID.safeParse(sourceId).success) {
    throw new DigestError(`Invalid source id "${sourceId}": not a plain folder name`);
  }
  if (isReservedSourceId(sourceId)) {
    throw new DigestError(`Invalid source id "${sourceId}": the name is reserved for the digest`);
  }
  return join(dataDir, assertDay(day), sourceId, part);
}

/** `<dataDir>/logs/<day>`. */
export function logsDir(dataDir: string, day: string): string {
  return join(dataDir, LOGS_DIR, assertDay(day));
}

/** A source with this id would share its day folder with the week's digest. */
export function isReservedSourceId(sourceId: string): boolean {
  return sourceId === DIGEST_DIR;
}

function assertDay(day: string): string {
  if (!DAY_PATTERN.test(day)) throw new DigestError(`Invalid day "${day}": expected YYYY-MM-DD`);
  return day;
}
