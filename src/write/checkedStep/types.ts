import type { Draft, Item } from '../../domain/schemas';
import type { GuardCheckId } from '../../guards/guardVerdict';
import type { Logger } from '../../shared/telemetry';

/** A draft with the exact Markdown that was checked. */
export interface CheckedDraft {
  readonly draft: Draft;
  readonly markdown: string;
}

/** A draft with what the link and format checks said; `rejectedBy` is empty when it passed. */
export interface CodeChecked extends CheckedDraft {
  readonly rejectedBy: readonly string[];
  /**
   * Format problems first, then link problems: the retry prompt, the log and drafts.json keep
   * only the first few, and a draft with many bad links must not hide a word-count problem.
   * Whole here; each consumer bounds them.
   */
  readonly problems: readonly string[];
}

/** One draft the link or format check rejected, as drafts.json keeps it. */
export interface Rejection {
  readonly writer: string;
  /** 1 for the writer's first draft, 2 for its retry. */
  readonly attempt: 1 | 2;
  readonly rejectedBy: readonly string[];
  /** Bounded: the first few, each cut short. They can quote model text. */
  readonly problems: readonly string[];
}

/** What the checks on a draft need to know about the run. */
export interface CheckContext {
  /** Every collected item: the link check accepts only their URLs. */
  collected: readonly Item[];
  /** The guards that are off this run; the rendered footer names them. */
  disabledGuards: readonly GuardCheckId[];
  /** A draft keeps at most this many items. */
  topN: number;
  logger: Logger;
}
