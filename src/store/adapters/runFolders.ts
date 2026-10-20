import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RunRecordSchema, type RunRecord } from '../runRecord';
import { DIGEST_DIR, isDayName, LOGS_DIR, weekDay, weekDigestDir, weekOfDay } from '../layout';
import { WEEK_ID_PATTERN } from '../../domain/schemas';
import { DigestError, errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { readTextIfExists } from '../../shared/atomicFile';
import { errnoCode } from '../../shared/fsErrors';

export const RUN_RECORD_FILE = 'run.json';
export const DIGEST_FILE = 'digest.md';
/** What `writeFileAtomic` leaves behind when a process dies mid-write. */
const TEMP_SUFFIX = '.tmp';

export interface RunFolders {
  /** The data folder; a week's run lives in <dataDir>/<monday>/digest (see `../layout`). */
  dataDir: string;
  logger: Logger;
}

/** Run ids become folder names, so anything but an ISO week id is refused. */
export function assertRunId(runId: string): void {
  if (!WEEK_ID_PATTERN.test(runId)) {
    throw new DigestError(`Invalid run id "${runId}": expected an ISO week like 2026-W43`);
  }
}

export function runDir(folders: RunFolders, runId: string): string {
  assertRunId(runId);
  return weekDigestDir(folders.dataDir, runId);
}

/** Week ids whose Monday folder has a digest folder, most recent first. */
export async function listWeekFolders(folders: RunFolders): Promise<string[]> {
  const weeks: string[] = [];
  for (const day of await subfolders(folders.dataDir)) {
    const weekId = weekOfDay(day);
    if (weekId === undefined) continue;
    if ((await subfolders(join(folders.dataDir, day))).includes(DIGEST_DIR)) weeks.push(weekId);
  }
  return weeks.sort().reverse();
}

/** Names of the folders in `dir`; none when it does not exist. */
async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * What `hasSentDigest` and `sentUrls` need from a run.json, and no more: enough to know that the
 * week went out and which links it carried. A `RunRecord` is one.
 */
export interface DeliveryFacts {
  readonly status: string;
  readonly deliveredTo?: readonly string[];
  readonly sentUrls: readonly string[];
}

/**
 * Just those fields, with no enum: a run.json written by a build that knows another channel id
 * fails `RunRecordSchema` as a whole, yet still says the week was sent.
 */
const DeliveryFactsSchema = z.object({
  runId: z.string(),
  status: z.string(),
  deliveredTo: z.array(z.string()).optional(),
  sentUrls: z.array(z.string()).optional(),
});

interface RunFileRead {
  /** The full record, when run.json parses against this build's schema and belongs to the week. */
  readonly record?: RunRecord;
  /** The delivery fields alone; always there when `record` is. */
  readonly facts?: DeliveryFacts;
}

/** The week's run.json, or undefined when it is missing, corrupt or belongs to another week. */
export async function readRunRecord(
  folders: RunFolders,
  runId: string,
): Promise<RunRecord | undefined> {
  return (await readRunFile(folders, runId))?.record;
}

/**
 * The delivery fields of the week's run.json. Like `readRunRecord`, but a file this build's full
 * schema refuses (after an upgrade and a rollback, say) still answers with the fields it can read,
 * so a sent week is not taken for an unsent one. The warning is the same.
 */
export async function readDeliveryFacts(
  folders: RunFolders,
  runId: string,
): Promise<DeliveryFacts | undefined> {
  return (await readRunFile(folders, runId))?.facts;
}

async function readRunFile(folders: RunFolders, runId: string): Promise<RunFileRead | undefined> {
  const path = join(runDir(folders, runId), RUN_RECORD_FILE);
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;

  const warnUnreadable = (error: unknown): void => {
    folders.logger.warn('Ignoring unreadable run.json', {
      runId,
      path,
      error: errorMessage(error),
    });
  };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    warnUnreadable(error);
    return undefined;
  }
  const full = RunRecordSchema.safeParse(json);
  if (full.success && full.data.runId === runId) return { record: full.data, facts: full.data };
  warnUnreadable(full.success ? new Error(`run.json belongs to ${full.data.runId}`) : full.error);
  return lenientFacts(json, runId);
}

/** The delivery fields of a run.json the full schema refused; none if even those are wrong. */
function lenientFacts(json: unknown, runId: string): RunFileRead | undefined {
  const parsed = DeliveryFactsSchema.safeParse(json);
  if (!parsed.success || parsed.data.runId !== runId) return undefined;
  const { status, deliveredTo, sentUrls = [] } = parsed.data;
  return { facts: { status, sentUrls, ...(deliveredTo && { deliveredTo }) } };
}

/**
 * Empties a week down to what was delivered: its digest folder keeps digest.md and the files the
 * Markdown channel wrote (<weekId>.md, .html, .failed.md); the sources' raw and formatted folders
 * of that Monday go. True when something was deleted.
 */
export async function pruneWeekFolder(folders: RunFolders, runId: string): Promise<boolean> {
  const dayDir = join(folders.dataDir, weekDay(runId));
  const digestDir = runDir(folders, runId);
  const kept = (name: string): boolean =>
    name === DIGEST_FILE || (name.startsWith(`${runId}.`) && !name.endsWith(TEMP_SUFFIX));
  const doomed = [
    ...(await readdir(dayDir))
      .filter((name) => name !== DIGEST_DIR)
      .map((name) => join(dayDir, name)),
    ...(await readdir(digestDir))
      .filter((name) => !kept(name))
      .map((name) => join(digestDir, name)),
  ];
  await Promise.all(doomed.map((path) => rm(path, { recursive: true, force: true })));
  return doomed.length > 0;
}

/**
 * Removes what is older than `cutoff` (YYYY-MM-DD) and belongs to no week: the source folders of
 * every day folder (a `digest fetch` day goes whole) and the log folders of those days. A week's
 * `digest/` folder stays: `pruneWeekFolder` empties it.
 */
export async function pruneOldDays(folders: RunFolders, cutoff: string): Promise<void> {
  const isOld = (name: string): boolean => isDayName(name) && name < cutoff;
  for (const day of (await subfolders(folders.dataDir)).filter(isOld)) {
    const dir = join(folders.dataDir, day);
    const keepsWeek = (await subfolders(dir)).includes(DIGEST_DIR);
    const doomed = keepsWeek
      ? (await readdir(dir)).filter((name) => name !== DIGEST_DIR).map((name) => join(dir, name))
      : [dir];
    await Promise.all(doomed.map((path) => rm(path, { recursive: true, force: true })));
  }
  const logs = join(folders.dataDir, LOGS_DIR);
  for (const day of (await subfolders(logs)).filter(isOld)) {
    await rm(join(logs, day), { recursive: true, force: true });
  }
}
