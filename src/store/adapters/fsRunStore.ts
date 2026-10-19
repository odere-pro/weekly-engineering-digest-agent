import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RunRecordSchema, type RunRecord } from '../runRecord';
import type { ArtifactName, RunLock, RunStore } from '../RunStore';
import { systemClock, type Clock } from '../../shared/clock';
import { previousWeekIds } from '../../shared/isoWeek';
import { noopLogger, type Logger } from '../../shared/telemetry';
import { artifactFile } from './artifactFiles';
import { readTextIfExists, writeFileAtomic } from './atomicFile';
import {
  assertRunId,
  listWeekFolders,
  pruneWeekFolder,
  readRunRecord,
  RUN_RECORD_FILE,
  runDir,
  type RunFolders,
} from './runFolders';
import { acquireRunLock } from './runLock';

export interface FsRunStoreOptions {
  /** Root data dir; runs live in <dataDir>/runs/<weekId>/, the lock in <dataDir>/. */
  dataDir: string;
  clock?: Clock;
  /** Receives warnings (stale lock takeover, corrupt run.json). Defaults to silent. */
  logger?: Logger;
}

const LOCK_FILE = 'digest.lock';

/** A sent week, or a failed one that some channels already got: its URLs must not repeat. */
function reachedAChannel(record: RunRecord): boolean {
  return record.status === 'sent' || (record.deliveredTo?.length ?? 0) > 0;
}

/** Run history on disk (W1-13). */
export function createFsRunStore(options: FsRunStoreOptions): RunStore {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const folders: RunFolders = { runsDir: join(options.dataDir, 'runs'), logger };
  const getRunRecord = (runId: string): Promise<RunRecord | undefined> =>
    readRunRecord(folders, runId);

  return {
    async acquireLock(runId: string): Promise<RunLock> {
      assertRunId(runId);
      const lockPath = join(options.dataDir, LOCK_FILE);
      return await acquireRunLock({ lockPath, runId, clock, logger });
    },

    async hasSentDigest(runId: string): Promise<boolean> {
      return (await getRunRecord(runId))?.status === 'sent';
    },

    async saveArtifact(runId: string, name: ArtifactName, content: string): Promise<void> {
      const file = artifactFile(name);
      const dir = runDir(folders, runId);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(join(dir, file), content);
    },

    async readArtifact(runId: string, name: ArtifactName): Promise<string | undefined> {
      const file = artifactFile(name);
      return readTextIfExists(join(runDir(folders, runId), file));
    },

    async saveRunRecord(record: RunRecord): Promise<void> {
      const valid = RunRecordSchema.parse(record);
      const dir = runDir(folders, valid.runId);
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(join(dir, RUN_RECORD_FILE), `${JSON.stringify(valid, null, 2)}\n`);
    },

    getRunRecord,

    async sentUrls(runId: string, weeks: number): Promise<Set<string>> {
      assertRunId(runId);
      const records = await Promise.all(previousWeekIds(runId, weeks).map(getRunRecord));
      const urls = new Set<string>();
      for (const record of records) {
        if (record && reachedAChannel(record)) record.sentUrls.forEach((url) => urls.add(url));
      }
      return urls;
    },

    async listRuns(limit = Number.POSITIVE_INFINITY): Promise<RunRecord[]> {
      const runs: RunRecord[] = [];
      for (const runId of await listWeekFolders(folders)) {
        if (runs.length >= limit) break;
        const record = await getRunRecord(runId);
        if (record !== undefined) runs.push(record);
      }
      return runs;
    },

    async prune(runId: string, keepWeeks: number): Promise<string[]> {
      assertRunId(runId);
      const keep = new Set([runId, ...previousWeekIds(runId, keepWeeks)]);
      // Week ids sort lexicographically; anything below runId is older, anything above is newer.
      const old = (await listWeekFolders(folders)).filter((id) => id < runId && !keep.has(id));
      const pruned: string[] = [];
      for (const id of old) {
        if (await pruneWeekFolder(folders, id)) pruned.push(id);
      }
      return pruned;
    },
  };
}
