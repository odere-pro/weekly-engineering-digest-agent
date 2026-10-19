import type { DeliveryId } from '../../delivery/deliveryId';
import type { Draft, Item, StepName } from '../../domain/schemas';
import type { ScoredItem } from '../../classify/classification';
import type { RunRecord, DraftOutcome } from '../../store/runRecord';
import type { CheckedDraft, CodeChecked } from '../../write/checkedStep/types';
import type { Failure, HeldArtifact } from '../ending/types';

/** Ends the run early with this status; the remaining steps are skipped. */
export interface Settled {
  readonly status: 'quiet' | 'blocked';
  /** The step that settled the run. `timed` stamps it, so a note always names the right one. */
  readonly step?: StepName;
  /** Sent as a failure note; none for an ordinary quiet week. */
  readonly note?: string;
}

/** What drafts.json holds. */
export interface DraftsFile {
  readonly drafts: readonly Draft[];
  readonly failures: readonly unknown[];
  readonly rejections: readonly unknown[];
}

/** What the chain has produced so far. Every step returns a new state. */
export interface ChainState {
  readonly collected: readonly Item[];
  readonly failedSources: RunRecord['failedSources'];
  readonly kept: readonly Item[];
  readonly scored: readonly ScoredItem[];
  /** Items that passed the process filters, before the top N cut. Unset until that step ran. */
  readonly afterProcess?: number;
  readonly selected: readonly ScoredItem[];
  /** The drafts after the writers' retry, each with its link and format check. */
  readonly checked: readonly CodeChecked[];
  readonly drafts: readonly DraftOutcome[];
  readonly passed: readonly CheckedDraft[];
  readonly winner?: CheckedDraft;
  /** What drafts.json holds, kept so the fallback can be added to it (W11-02). */
  readonly draftsFile?: DraftsFile;
  /** The winner is the template-only fallback, not a writer's draft (W11-02). */
  readonly fallback?: boolean;
  readonly sentUrls: readonly string[];
  /** Channels that took the digest, in the order they took it. */
  readonly deliveredTo: readonly DeliveryId[];
  readonly timings: RunRecord['timings'];
  /** Files built but not written; see `RunContext.holdArtifacts`. */
  readonly held: readonly HeldArtifact[];
  readonly settled?: Settled;
}

/** How the chain ended: its state, and the failure that stopped it, if any. */
export interface ChainOutcome {
  readonly state: ChainState;
  readonly failure?: Failure;
}

export const EMPTY_STATE: ChainState = {
  collected: [],
  failedSources: [],
  kept: [],
  scored: [],
  selected: [],
  checked: [],
  drafts: [],
  passed: [],
  sentUrls: [],
  deliveredTo: [],
  timings: [],
  held: [],
};
