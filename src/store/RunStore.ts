import type { RunRecord } from './runRecord';

export type ArtifactName =
  'items.json' | 'scores.json' | 'drafts.json' | 'digest.md' | 'review.md' | 'error.json';

export interface RunLock {
  /**
   * Fires once the lock is found to be no longer this run's: another run took it over after this
   * one went quiet past the heartbeat timeout (a stall, a sleeping laptop), or the lock file was
   * removed. The week then belongs to the other run, so the holder must stop: send nothing, write
   * nothing. The reason is `lockLostReason()` (`lockLost.ts`). `release()` does not fire it.
   */
  readonly lost: AbortSignal;
  /** Stops holding the lock. Safe to repeat; never removes a lock another run took over. */
  release(): Promise<void>;
}

/** Run history on disk (or elsewhere). One folder per ISO week. */
export interface RunStore {
  /** Throws DigestError (exit 1) if another run holds the lock. */
  acquireLock(runId: string): Promise<RunLock>;
  /** True when the week's run.json has status "sent". */
  hasSentDigest(runId: string): Promise<boolean>;
  saveArtifact(runId: string, name: ArtifactName, content: string): Promise<void>;
  /** The saved artifact, or undefined when the week has none. */
  readArtifact(runId: string, name: ArtifactName): Promise<string | undefined>;
  /** Removes a saved artifact; nothing to do when the week has none. */
  removeArtifact(runId: string, name: ArtifactName): Promise<void>;
  saveRunRecord(record: RunRecord): Promise<void>;
  getRunRecord(runId: string): Promise<RunRecord | undefined>;
  /** URLs delivered in the `weeks` weeks before `runId`: sent weeks and partly delivered weeks alike. */
  sentUrls(runId: string, weeks: number): Promise<Set<string>>;
  /** Most recent first. */
  listRuns(limit?: number): Promise<RunRecord[]>;
  /**
   * Deletes runs older than `keepWeeks` before `runId`, keeping their digest.md (and, on disk, the
   * delivered files and the fetched data and logs of older days). Returns pruned run ids.
   */
  prune(runId: string, keepWeeks: number): Promise<string[]>;
}
