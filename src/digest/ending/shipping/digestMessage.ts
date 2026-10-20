import type { ScoredItem } from '../../../classify/classification';
import type { DigestMessage } from '../../../delivery/Delivery';
import type { DigestView } from '../../../render/digestView';
import type { GuardCheckId } from '../../../guards/guardVerdict';
import { buildDigestView } from '../../../render/layout';
import { buildAppendix, renderAppendix } from '../../../render/appendix';
import { visibleLine } from '../../../render/visibleLine';
import { truncate } from '../../../shared/text';
import type { CheckedDraft } from '../../../write/checkedStep/types';
import { variantLabel, variantSlug, type RunVariant } from '../../variant';

const SUBJECT_MAX_CHARS = 120;

/**
 * The message every channel gets: a one-line subject over the digest's Markdown, and the laid-out
 * `view` when there is one (W8-02). A channel without a view shows the Markdown. The headline is
 * model text, so it goes through `visibleLine` like the body: no bidi, zero-width, tag or control
 * character reaches the mail Subject.
 */
export function digestMessage(
  weekId: string,
  headline: string,
  markdown: string,
  view?: DigestView,
  variant?: { slug: string; label: string },
): DigestMessage {
  const oneLine = visibleLine(headline);
  const head = variant
    ? `Engineering digest ${weekId} (${visibleLine(variant.label)})`
    : `Engineering digest ${weekId}`;
  const subject = oneLine ? `${head}: ${oneLine}` : head;
  return {
    weekId,
    subject: truncate(subject, SUBJECT_MAX_CHARS),
    markdown,
    ...(view && { view }),
    ...(variant && { variant: variant.slug }),
  };
}

/** What a run knows about the digest it sends: the week and the guards that were off. */
export interface WinnerContext {
  readonly weekId: string;
  readonly disabledGuards: readonly GuardCheckId[];
  /** A second run of the week: its slug and label go on the message, and the view carries the label. */
  readonly variant?: RunVariant;
}

/** The message every channel gets for the winning draft: its Markdown and its laid-out view. */
export function winnerMessage(
  { weekId, disabledGuards, variant }: WinnerContext,
  winner: CheckedDraft,
  fallback: boolean,
  eligible: readonly ScoredItem[] = [],
): DigestMessage {
  const { digest } = winner.draft;
  const built = buildDigestView(digest, { disabledGuards, fallback });
  if (!variant) return digestMessage(weekId, digest.headline, winner.markdown, built);
  const label = variantLabel(variant);
  const appendix = variant.kind === 'complete' ? buildAppendix(eligible) : undefined;
  const view = { ...built, variant: label, ...(appendix && { appendix }) };
  const markdown = appendix ? winner.markdown + renderAppendix(appendix) : winner.markdown;
  return digestMessage(weekId, digest.headline, markdown, view, {
    slug: variantSlug(variant),
    label,
  });
}
