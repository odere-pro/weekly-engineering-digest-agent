import { DIGEST_SUMMARY_WORD_LIMIT } from '../checks/formatCheck';
import type { Digest, DigestItem, Draft, Item } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import type { GuardCheckId } from '../guards/guardVerdict';
import type { RenderOptions } from '../render/markdown';
import { cutSummary, plain, titleOf } from '../render/sourceLine';
import { codeCheck } from './checkedStep/codeCheck';
import type { CodeChecked } from './checkedStep/types';

/** The `writer` of the fallback draft in the run record. */
export const FALLBACK_WRITER = 'fallback';

const INTRO = "These are the selected releases, in the sources' own words.";
const MAX_AREAS = 3;

export interface FallbackOptions {
  readonly weekId: string;
  /** The digest keeps at most this many items. */
  readonly topN: number;
  /** Every collected item: the link check accepts only their URLs. */
  readonly collected: readonly Item[];
  readonly disabledGuards: readonly GuardCheckId[];
}

function headlineOf(items: readonly ScoredItem[]): string {
  const areas = [...new Set(items.map((item) => plain(item.classification.area)))]
    .filter((area) => area !== '')
    .slice(0, MAX_AREAS);
  return areas.length === 0 ? 'Releases this week' : `Releases this week: ${areas.join(', ')}`;
}

function entryOf(item: ScoredItem): DigestItem {
  const area = plain(item.classification.area) || 'Releases';
  return {
    itemId: item.id,
    title: titleOf(item),
    url: item.url,
    area,
    summary: cutSummary(item.summary, DIGEST_SUMMARY_WORD_LIMIT),
    // Not shown for a good-to-know item; the schema wants it.
    whyItMatters: `Area: ${area}.`,
    urgency: 'good-to-know',
  };
}

/**
 * A digest made from the selected items' own text, with no model (W11-02). Every field is the
 * item's own title, summary or url, or fixed text, so it is grounded by construction. Items
 * stay in rank order, all good-to-know: no model judged their urgency. Pure.
 */
export function buildFallbackDigest(
  items: readonly ScoredItem[],
  options: Pick<FallbackOptions, 'weekId' | 'topN'>,
): Digest {
  const kept = items.slice(0, options.topN);
  return {
    weekId: options.weekId,
    headline: headlineOf(kept),
    intro: INTRO,
    items: kept.map(entryOf),
  };
}

/** The fallback draft rendered with its footer line and run through the link and format checks. */
export function checkedFallback(
  items: readonly ScoredItem[],
  options: FallbackOptions,
): CodeChecked {
  const draft: Draft = { writer: FALLBACK_WRITER, digest: buildFallbackDigest(items, options) };
  const render: RenderOptions = { disabledGuards: options.disabledGuards, fallback: true };
  return codeCheck(draft, options.collected, render);
}
