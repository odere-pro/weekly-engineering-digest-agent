import type { DigestView } from '../render/digestView';

export interface DigestMessage {
  weekId: string;
  subject: string;
  markdown: string;
  /** The laid-out digest; channels without it fall back to `markdown`. */
  view?: DigestView;
  /** A second run's variant slug (`enriched`, `complete`, `perspective-<topic>`); none for the week's own digest. */
  variant?: string;
}

export interface FailureNote {
  weekId: string;
  step?: string;
  message: string;
}

/** A delivery channel. Recipients and endpoints come from config and secrets only. */
export interface Delivery {
  readonly id: 'markdown' | 'email' | 'slack';
  sendDigest(message: DigestMessage): Promise<void>;
  sendFailure(note: FailureNote): Promise<void>;
  /**
   * Takes back the week's failure note where the channel keeps it (the Markdown file's
   * `<week>.failed.md`), once the week is sent. A sent mail or Slack message stays: no-op there.
   */
  clearFailure(weekId: string): Promise<void>;
}
