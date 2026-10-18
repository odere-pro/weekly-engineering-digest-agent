import type { RunRecord } from '../../src/store/runRecord';
import type { ArtifactName, RunLock, RunStore } from '../../src/store/RunStore';
import { DigestError } from '../../src/shared/errors';
import { compareWeekIds, previousWeekIds } from '../../src/shared/isoWeek';

/** In-memory RunStore with the same contract as fsRunStore. */
export class MemoryRunStore implements RunStore {
  readonly artifacts = new Map<string, string>();
  readonly records = new Map<string, RunRecord>();
  private locked = false;

  acquireLock(_runId: string): Promise<RunLock> {
    if (this.locked) return Promise.reject(new DigestError('Another run is in progress'));
    this.locked = true;
    return Promise.resolve({
      release: () => {
        this.locked = false;
        return Promise.resolve();
      },
    });
  }

  get isLocked(): boolean {
    return this.locked;
  }

  hasSentDigest(runId: string): Promise<boolean> {
    return Promise.resolve(this.records.get(runId)?.status === 'sent');
  }

  saveArtifact(runId: string, name: ArtifactName, content: string): Promise<void> {
    this.artifacts.set(`${runId}/${name}`, content);
    return Promise.resolve();
  }

  readArtifact(runId: string, name: ArtifactName): Promise<string | undefined> {
    return Promise.resolve(this.artifacts.get(`${runId}/${name}`));
  }

  saveRunRecord(record: RunRecord): Promise<void> {
    this.records.set(record.runId, record);
    return Promise.resolve();
  }

  getRunRecord(runId: string): Promise<RunRecord | undefined> {
    return Promise.resolve(this.records.get(runId));
  }

  sentUrls(runId: string, weeks: number): Promise<Set<string>> {
    const urls = new Set<string>();
    for (const week of previousWeekIds(runId, weeks)) {
      const record = this.records.get(week);
      // Same rule as fsRunStore: a sent week, or a failed one that some channels already got.
      const reachedAChannel = record?.status === 'sent' || (record?.deliveredTo?.length ?? 0) > 0;
      if (record && reachedAChannel) record.sentUrls.forEach((u) => urls.add(u));
    }
    return Promise.resolve(urls);
  }

  listRuns(limit = Number.POSITIVE_INFINITY): Promise<RunRecord[]> {
    const runs = [...this.records.values()].sort((a, b) => compareWeekIds(b.runId, a.runId));
    return Promise.resolve(runs.slice(0, limit));
  }

  prune(runId: string, keepWeeks: number): Promise<string[]> {
    const keep = new Set([runId, ...previousWeekIds(runId, keepWeeks)]);
    const pruned = [...this.records.keys()].filter(
      (id) => !keep.has(id) && compareWeekIds(id, runId) < 0,
    );
    for (const id of pruned) this.records.delete(id);
    return Promise.resolve(pruned);
  }
}
