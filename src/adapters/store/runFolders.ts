import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RunRecordSchema, WEEK_ID_PATTERN, type RunRecord } from '../../core/schemas.js';
import { DigestError, errorMessage } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';
import { isErrnoException, readTextIfExists } from './atomicFile.js';

export const RUN_RECORD_FILE = 'run.json';
export const DIGEST_FILE = 'digest.md';

export interface RunFolders {
  /** <dataDir>/runs */
  runsDir: string;
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
  return join(folders.runsDir, runId);
}

/** Week ids that have a folder under runs/, most recent first. */
export async function listWeekFolders(folders: RunFolders): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(folders.runsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && WEEK_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
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

/** Deletes everything in the week's folder except digest.md. True when something was deleted. */
export async function pruneWeekFolder(folders: RunFolders, runId: string): Promise<boolean> {
  const dir = runDir(folders, runId);
  const doomed = (await readdir(dir)).filter((name) => name !== DIGEST_FILE);
  await Promise.all(doomed.map((name) => rm(join(dir, name), { recursive: true, force: true })));
  return doomed.length > 0;
}
