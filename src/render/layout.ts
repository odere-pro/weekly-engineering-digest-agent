import type { DigestView, DigestViewGroup, DigestViewItem } from '../delivery/Delivery';
import type { Digest, DigestItem, Urgency } from '../domain/schemas';
import type { GuardCheckId } from '../guards/guardVerdict';

export interface LayoutOptions {
  /** Guards that were off this week; named in the footer. */
  readonly disabledGuards: readonly GuardCheckId[];
  /** The digest is the template-only fallback (W11-02); the footer says so. */
  readonly fallback?: boolean;
}

/** The footer line of a digest built without a model. */
export const FALLBACK_NOTE = "Written from the sources' own words.";

/** The order groups are shown in: most urgent first. */
const URGENCY_ORDER: readonly Urgency[] = ['act-now', 'worth-a-look', 'good-to-know'];

/** An item without an urgency (a draft written before W8) is read as this. */
const DEFAULT_URGENCY: Urgency = 'worth-a-look';

/** Fixed labels from code, never from a model. */
const URGENCY_LABEL: Readonly<Record<Urgency, string>> = {
  'act-now': 'Act now',
  'worth-a-look': 'Worth a look',
  'good-to-know': 'Good to know',
};

const urgencyOf = (item: DigestItem): Urgency => item.urgency ?? DEFAULT_URGENCY;

function hasText(text: string | undefined): text is string {
  return text !== undefined && text.trim() !== '';
}

/** A good-to-know item shows no action. An old draft's item without one shows why it matters. */
function viewItem(item: DigestItem): DigestViewItem {
  const shown: DigestViewItem = { title: item.title, url: item.url, whatChanged: item.summary };
  if (urgencyOf(item) === 'good-to-know') return shown;
  return { ...shown, action: hasText(item.action) ? item.action : item.whyItMatters };
}

function groupOf(urgency: Urgency, items: readonly DigestItem[]): DigestViewGroup[] {
  const inGroup = items.filter((item) => urgencyOf(item) === urgency);
  if (inGroup.length === 0) return [];
  return [{ urgency, label: URGENCY_LABEL[urgency], items: inGroup.map(viewItem) }];
}

function needsAction(count: number): string {
  if (count === 0) return 'nothing needs action';
  return count === 1 ? '1 needs action' : `${count} need action`;
}

/** For example "Week 2026-W42: 5 releases, 1 needs action". */
function titleOf(weekId: string, items: readonly DigestItem[]): string {
  const releases = items.length === 1 ? '1 release' : `${items.length} releases`;
  const actNow = items.filter((item) => urgencyOf(item) === 'act-now').length;
  return `Week ${weekId}: ${releases}, ${needsAction(actNow)}`;
}

function footerOf(options: LayoutOptions): string | undefined {
  const { disabledGuards, fallback } = options;
  const lines = [
    ...(fallback === true ? [FALLBACK_NOTE] : []),
    ...(disabledGuards.length > 0 ? [`Guards off this week: ${disabledGuards.join(', ')}.`] : []),
  ];
  return lines.length === 0 ? undefined : lines.join(' ');
}

/**
 * The digest laid out for reading (W8-02): a computed title, the model headline and the items
 * grouped by urgency, most urgent first, in the writer's order within a group. Every channel
 * renders this view. Pure: reads the digest, returns a new object.
 */
export function buildDigestView(digest: Digest, options: LayoutOptions): DigestView {
  const footer = footerOf(options);
  return {
    weekId: digest.weekId,
    title: titleOf(digest.weekId, digest.items),
    headline: digest.headline,
    groups: URGENCY_ORDER.flatMap((urgency) => groupOf(urgency, digest.items)),
    ...(footer === undefined ? {} : { footer }),
  };
}
