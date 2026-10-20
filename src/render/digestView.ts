import type { Urgency } from '../domain/schemas';

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

/** One release of the appendix: its own title, page and a short line from its own summary. */
export interface DigestAppendixItem {
  title: string;
  url: string;
  line: string;
}

/** The appendix items of one area. */
export interface DigestAppendixGroup {
  area: string;
  items: readonly DigestAppendixItem[];
}

/** Every release of the week by area, below the digest (a "complete" digest). */
export interface DigestAppendix {
  title: string;
  groups: readonly DigestAppendixGroup[];
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
  /** Short label of a variant digest, for example `enriched` or `perspective: security`. */
  variant?: string;
  /** Every release of the week, shown after the footer. */
  appendix?: DigestAppendix;
}
