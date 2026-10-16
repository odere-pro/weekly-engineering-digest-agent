import type { RunRecord } from '../core/schemas.js';

export type ArtifactName =
  'items.json' | 'scores.json' | 'drafts.json' | 'digest.md' | 'error.json';

export interface RunLock {
  release(): Promise<void>;
}

/** Run history on disk (or elsewhere). One folder per ISO week. */
export interface RunStore {
  /** Throws DigestError (exit 1) if another run holds the lock. */
  acquireLock(runId: string): Promise<RunLock>;
  /** True when the week's run.json has status "sent". */
  hasSentDigest(runId: string): Promise<boolean>;
  saveArtifact(runId: string, name: ArtifactName, content: string): Promise<void>;
  saveRunRecord(record: RunRecord): Promise<void>;
  getRunRecord(runId: string): Promise<RunRecord | undefined>;
  /** URLs sent in the `weeks` weeks before `runId`. */
  sentUrls(runId: string, weeks: number): Promise<Set<string>>;
  /** Most recent first. */
  listRuns(limit?: number): Promise<RunRecord[]>;
  /** Deletes runs older than `keepWeeks` before `runId`, keeping their digest.md. Returns pruned run ids. */
  prune(runId: string, keepWeeks: number): Promise<string[]>;
}
