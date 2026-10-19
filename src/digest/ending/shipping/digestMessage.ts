import type { DigestMessage, DigestView } from '../../../delivery/Delivery';
import type { GuardCheckId } from '../../../guards/guardVerdict';
import { buildDigestView } from '../../../render/layout';
import { truncate } from '../../../shared/text';
import type { CheckedDraft } from '../../../write/write';

const SUBJECT_MAX_CHARS = 120;

/**
 * The message every channel gets: a one-line subject over the digest's Markdown, and the laid-out
 * `view` when there is one (W8-02). A channel without a view shows the Markdown.
 */
export function digestMessage(
  weekId: string,
  headline: string,
  markdown: string,
  view?: DigestView,
): DigestMessage {
  const oneLine = headline.replace(/\s+/g, ' ').trim();
  const subject = oneLine
    ? `Engineering digest ${weekId}: ${oneLine}`
    : `Engineering digest ${weekId}`;
  return { weekId, subject: truncate(subject, SUBJECT_MAX_CHARS), markdown, ...(view && { view }) };
}

/** What a run knows about the digest it sends: the week and the guards that were off. */
export interface WinnerContext {
  readonly weekId: string;
  readonly disabledGuards: readonly GuardCheckId[];
}

/** The message every channel gets for the winning draft: its Markdown and its laid-out view. */
export function winnerMessage(
  { weekId, disabledGuards }: WinnerContext,
  winner: CheckedDraft,
  fallback: boolean,
): DigestMessage {
  const { digest } = winner.draft;
  const view = buildDigestView(digest, { disabledGuards, fallback });
  return digestMessage(weekId, digest.headline, winner.markdown, view);
}
