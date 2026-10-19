import type { Config } from '../../config/schema';
import type { Delivery, FailureNote } from '../../delivery/Delivery';
import type { StepName } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import type { ArtifactName, RunStore } from '../../store/RunStore';
import type { RunRecord } from '../../store/runRecord';

/** What ending a run needs; the run context of runDigest has it. */
export interface EndingContext {
  readonly weekId: string;
  /** A dry run sends no failure note. */
  readonly dryRun: boolean;
  /**
   * False holds back the failure note of a run that failed, for a caller that will try the run
   * again (`RunOptions.notifyFailure`). Default true. The note is sent anyway when no retry can
   * follow: the failure says the run was told to stop, or that only `digest run --force` can
   * clear it (see `isUnretriable`), and when the run record could not be saved. A held note is
   * the caller's to send (`sendHeldNote`) if the retry it waited for does not happen.
   */
  readonly notifyFailure?: boolean;
  readonly logger: Logger;
  readonly deps: {
    readonly store: RunStore;
    readonly deliveries: readonly Delivery[];
    readonly config: Pick<Config, 'keepWeeks'>;
  };
}

/** Why a run failed, and the step it failed in when it was in one. */
export interface Failure {
  readonly error: unknown;
  readonly step?: StepName;
}

/** A run file a run built but has not written; see `Ending.artifacts`. */
export interface HeldArtifact {
  readonly name: ArtifactName;
  readonly content: string;
}

/** How a run ends: the record to save, the failure behind it and the note to send. */
export interface Ending {
  readonly record: RunRecord;
  readonly failure?: Failure;
  readonly note?: FailureNote;
  /**
   * Run files held back because an earlier record of the week reached a channel, so they go to
   * the store only when `record` replaces it. Later entries replace earlier ones of the same name.
   */
  readonly artifacts?: readonly HeldArtifact[];
}

/** What ending a run reports back to the run. */
export interface Ended {
  /** The held artifacts that were written; none when the week's earlier record stayed. */
  readonly written: ReadonlySet<ArtifactName>;
  /** Why the week's earlier record stayed instead of this run's (see `keepReason`); else absent. */
  readonly kept?: string;
}
