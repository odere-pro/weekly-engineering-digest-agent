import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RunRecordSchema, type RunRecord } from '../runRecord';
import { DIGEST_DIR, isDayName, LOGS_DIR, weekDay, weekDigestDir, weekOfDay } from '../layout';
import { WEEK_ID_PATTERN } from '../../domain/schemas';
import { DigestError, errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { isErrnoException, readTextIfExists } from '../../shared/atomicFile';

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
    if (isErrnoException(error, 'ENOENT')) return [];
    throw error;
  }
}

/** The week's run.json, or undefined when it is missing, corrupt or belongs to another week. */
export async function readRunRecord(
  folders: RunFolders,
  runId: string,
): Promise<RunRecord | undefined> {
  const path = join(runDir(folders, runId), RUN_RECORD_FILE);
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;

  try {
    const record = RunRecordSchema.parse(JSON.parse(text));
    if (record.runId !== runId) throw new Error(`run.json belongs to ${record.runId}`);
    return record;
  } catch (error) {
    folders.logger.warn('Ignoring unreadable run.json', {
      runId,
      path,
      error: errorMessage(error),
    });
    return undefined;
  }
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
