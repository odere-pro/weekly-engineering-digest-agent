import { DIGEST_SUMMARY_WORD_LIMIT } from '../checks/formatCheck';
import type { Digest, DigestItem, Draft, Item } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import type { GuardCheckId } from '../guards/guardVerdict';
import type { RenderOptions } from '../render/markdown';
import { truncate } from '../shared/text';
import { codeCheck } from './checkedStep/codeCheck';
import type { CodeChecked } from './checkedStep/types';

/** The `writer` of the fallback draft in the run record. */
export const FALLBACK_WRITER = 'fallback';

const NO_SUMMARY = 'No summary in the source.';
const INTRO = "These are the selected releases, in the sources' own words.";
const MAX_TITLE_CHARS = 120;
const MAX_AREAS = 3;
const ELLIPSIS = '...';
/** A token that holds one of these could become a link; a url in a source's text is dropped. */
const LINK_LIKE = /:\/\/|\b(?:https?|ftp|mailto|javascript):|\bwww\.|\/\/|\]\(|&#/i;
/** An attribute the link check reads as a destination; its value is dropped with it. */
const ATTRIBUTE = /\b(?:href|src)\s*=/gi;
/** A character reference: the link check decodes it, so a token with one is dropped. */
const REFERENCE = /&[#a-z0-9]+;/i;
const EM_DASH = /\s*—+\s*/g;
const WORD = /[\p{L}\p{N}]/u;
/** A sentence ends at ., ! or ? followed by a space, so "1.0" and "v2.1.3" do not end one. */
const SENTENCE_END = /(?<=[.!?])\s+/;

export interface FallbackOptions {
  readonly weekId: string;
  /** The digest keeps at most this many items. */
  readonly topN: number;
  /** Every collected item: the link check accepts only their URLs. */
  readonly collected: readonly Item[];
  readonly disabledGuards: readonly GuardCheckId[];
}

/**
 * Plain text from a source: one line, no link-like token, no em dash (the format check rejects
 * it), no pipe (a table cell separator). Pure.
 */
function plain(text: string): string {
  return text
    .replace(EM_DASH, ' - ')
    .replace(ATTRIBUTE, ' ')
    .replaceAll('|', ' ')
    .replaceAll('\\', '')
    .split(/\s+/)
    .filter((token) => token !== '' && !LINK_LIKE.test(token) && !REFERENCE.test(token))
    .join(' ');
}

const wordsOf = (text: string): string[] => text.split(' ').filter((t) => WORD.test(t));

/**
 * The first whole sentences of the text that fit in `maxWords`. A first sentence that is longer
 * than that is cut at a word and ends in "...". An empty text gives a fixed line.
 */
export function cutSummary(text: string, maxWords: number): string {
  const clean = plain(text);
  if (clean === '') return NO_SUMMARY;
  const kept: string[] = [];
  let count = 0;
  for (const sentence of clean.split(SENTENCE_END)) {
    const next = count + wordsOf(sentence.trim()).length;
    if (next > maxWords) break;
    kept.push(sentence.trim());
    count = next;
  }
  if (kept.length > 0) return kept.join(' ');
  return `${clean
    .split(' ')
    .slice(0, maxWords)
    .join(' ')
    .replace(/[.,;:!?]+$/, '')}${ELLIPSIS}`;
}

function titleOf(item: Item): string {
  return truncate(plain(item.title), MAX_TITLE_CHARS).trim() || item.url;
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
