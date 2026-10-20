import type { RunRecord } from '../../src/store/runRecord';
import type { ArtifactName, RunLock, RunStore } from '../../src/store/RunStore';
import { DigestError } from '../../src/shared/errors';
import { compareWeekIds, previousWeekIds } from '../../src/shared/isoWeek';
import { lockLostReason } from '../../src/store/lockLost';

/** In-memory RunStore with the same contract as fsRunStore. */
export class MemoryRunStore implements RunStore {
  readonly artifacts = new Map<string, string>();
  readonly records = new Map<string, RunRecord>();
  /** The holder's `lost`, while a run holds the lock. */
  private holder: AbortController | undefined;

  acquireLock(_runId: string): Promise<RunLock> {
    if (this.holder) return Promise.reject(new DigestError('Another run is in progress'));
    const mine = new AbortController();
    this.holder = mine;
    return Promise.resolve({
      lost: mine.signal,
      release: () => {
        // Like the file lock: a lock another run took over stays theirs.
        if (this.holder === mine) this.holder = undefined;
        return Promise.resolve();
      },
    });
  }

  get isLocked(): boolean {
    return this.holder !== undefined;
  }

  /**
   * Takes the lock from its holder, as a takeover after a stall does, and fires its `lost` the way
   * the file lock's next heartbeat would. The next `acquireLock` succeeds.
   */
  loseLock(): void {
    const holder = this.holder;
    this.holder = undefined;
    holder?.abort(lockLostReason());
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

  removeArtifact(runId: string, name: ArtifactName): Promise<void> {
    this.artifacts.delete(`${runId}/${name}`);
    return Promise.resolve();
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
