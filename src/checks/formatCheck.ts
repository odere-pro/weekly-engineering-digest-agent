import type { Digest, DigestItem } from '../domain/schemas';
import type { CheckResult } from './types';

/** The format rules from the spec. The write prompt shows the writer these same numbers. */
export const DIGEST_MIN_ITEMS = 3;
export const DIGEST_MAX_ITEMS = 5;
export const DIGEST_WORD_LIMIT = 500;
/** W8-01: a digest that marks more items "act now" has no priorities left. */
export const DIGEST_MAX_ACT_NOW = 3;
/** The writer is asked for less (15 and 30 words), so a draft that is a little long still passes. */
export const DIGEST_ACTION_WORD_LIMIT = 20;
export const DIGEST_SUMMARY_WORD_LIMIT = 40;
const EM_DASH = '—';

/**
 * Text that a mail client, Slack or a Markdown renderer could turn into a link: a `scheme://`,
 * `http:`, `mailto:` and similar, `www.`, a protocol-relative `//host`, a Markdown destination
 * `](` or a character reference. The link check reads `action` too, but an action is one plain
 * line, so any of these is a problem here, even a collected url. The scheme length is bounded to
 * keep the scan linear.
 */
const LINK_IN_TEXT =
  /\b[a-z][a-z0-9+.-]{1,31}:\/\/|\b(?:https?|ftp|mailto|javascript):|\bwww\.|(?<![:/\w])\/\/\S|\]\(|&#/i;

function missingSections(digest: Digest): string[] {
  const missing: string[] = [];
  if (digest.headline.trim() === '') missing.push('Missing headline');
  if (digest.intro.trim() === '') missing.push('Missing intro');
  digest.items.forEach((item, i) => {
    if (item.summary.trim() === '') missing.push(`Missing summary in item ${i + 1}`);
    if (item.whyItMatters.trim() === '') missing.push(`Missing why-it-matters in item ${i + 1}`);
  });
  return missing;
}

/** A word is a whitespace-separated token with a letter or a digit: pipes, rules and bullets are layout. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Words in `text`, the way every limit below counts them. A pipe separates words. */
function countWords(text: string): number {
  return text
    .replaceAll('|', ' ')
    .split(/\s+/)
    .filter((token) => WORD_CHARACTER.test(token)).length;
}

/**
 * An act-now or worth-a-look item needs its action line. A draft written before W8 has no urgency:
 * it reads as worth-a-look with `whyItMatters` as its action, which `missingSections` checks.
 */
function needsAction(item: DigestItem): boolean {
  return item.urgency === 'act-now' || item.urgency === 'worth-a-look';
}

/** One problem for all of them, so five bare items cannot crowd every other problem out of a retry. */
function missingActions(digest: Digest): string[] {
  const positions = digest.items.flatMap((item, i) =>
    needsAction(item) && (item.action?.trim() ?? '') === '' ? [i + 1] : [],
  );
  if (positions.length === 0) return [];
  return [`Missing action in ${positions.length === 1 ? 'item' : 'items'} ${positions.join(', ')}`];
}

/**
 * The action may not hold a link; the limits apply to an item that has an urgency. Drafts written
 * before W8 have none, so recorded digests (and their longer summaries) pass as they always did.
 */
function itemLineProblems(item: DigestItem, position: number): string[] {
  const problems: string[] = [];
  const action = item.action?.trim() ?? '';
  if (LINK_IN_TEXT.test(action)) problems.push(`Action of item ${position} contains a link`);
  if (item.urgency === undefined) return problems;
  const actionWords = countWords(action);
  if (actionWords > DIGEST_ACTION_WORD_LIMIT) {
    problems.push(
      `Expected at most ${DIGEST_ACTION_WORD_LIMIT} words in the action of item ${position}, got ${actionWords}`,
    );
  }
  const summaryWords = countWords(item.summary);
  if (summaryWords > DIGEST_SUMMARY_WORD_LIMIT) {
    problems.push(
      `Expected at most ${DIGEST_SUMMARY_WORD_LIMIT} words in the summary of item ${position}, got ${summaryWords}`,
    );
  }
  return problems;
}

function urgencyProblems(digest: Digest): string[] {
  const problems = [
    ...missingActions(digest),
    ...digest.items.flatMap((item, i) => itemLineProblems(item, i + 1)),
  ];
  const actNow = digest.items.filter((item) => item.urgency === 'act-now').length;
  if (actNow > DIGEST_MAX_ACT_NOW) {
    problems.push(`Expected at most ${DIGEST_MAX_ACT_NOW} act-now items, got ${actNow}`);
  }
  return problems;
}

const LINK_TARGET = /\]\((?:[^\s()]|\([^\s()]*\))*\)/g;

/**
 * Link targets do not count as words, and neither does Markdown layout: a pipe, a `---` row, a
 * heading mark or a bullet. The limit then holds for any template the renderer uses.
 */
function readableWordCount(markdown: string): number {
  return countWords(markdown.replace(LINK_TARGET, ']'));
}

/**
 * Item count, every section present, the urgency, action and summary limits (W8-01), no em
 * dashes, under the word limit. Always on.
 */
export function formatCheck(digest: Digest, markdown: string): CheckResult {
  const problems = [...missingSections(digest), ...urgencyProblems(digest)];
  const count = digest.items.length;
  if (count < DIGEST_MIN_ITEMS || count > DIGEST_MAX_ITEMS) {
    problems.unshift(`Expected ${DIGEST_MIN_ITEMS}-${DIGEST_MAX_ITEMS} items, got ${count}`);
  }
  if (markdown.includes(EM_DASH)) problems.push('Contains an em dash');
  const words = readableWordCount(markdown);
  if (words >= DIGEST_WORD_LIMIT) {
    problems.push(`Expected under ${DIGEST_WORD_LIMIT} words, got ${words}`);
  }
  return { ok: problems.length === 0, problems };
}
