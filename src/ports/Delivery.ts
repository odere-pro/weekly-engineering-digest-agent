import type { Urgency } from '../core/schemas.js';

/** One digest item as every channel shows it (W8). */
export interface DigestViewItem {
  title: string;
  url: string;
  /** One sentence: what changed. */
  whatChanged: string;
  /** What to do, or who it is for; absent for good-to-know items. */
  action?: string;
}

/** The items of one urgency, in the order the digest shows them. */
export interface DigestViewGroup {
  urgency: Urgency;
  /** Fixed label from code, for example "Act now". */
  label: string;
  items: readonly DigestViewItem[];
}

/** The digest laid out for reading (W8): built by the core, rendered by each channel. */
export interface DigestView {
  weekId: string;
  /** Computed in code, for example "Week 2026-W42: 5 releases, 1 needs action". */
  title: string;
  headline: string;
  /** Non-empty groups only, most urgent first. */
  groups: readonly DigestViewGroup[];
  /** Footer line, for example the guards that were off; absent when there is nothing to say. */
  footer?: string;
}

export interface DigestMessage {
  weekId: string;
  subject: string;
  markdown: string;
  /** The laid-out digest; channels without it fall back to `markdown`. */
  view?: DigestView;
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
}
