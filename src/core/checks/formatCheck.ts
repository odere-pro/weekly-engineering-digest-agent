import type { Digest } from '../schemas.js';
import { wordCount } from '../../shared/text.js';
import type { CheckResult } from './types.js';

/** The format rules from the spec. The write prompt shows the writer these same numbers. */
export const DIGEST_MIN_ITEMS = 3;
export const DIGEST_MAX_ITEMS = 5;
export const DIGEST_WORD_LIMIT = 500;
const EM_DASH = '—';

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

/** Link targets do not count as words. */
function readableWordCount(markdown: string): number {
  return wordCount(markdown.replace(/\]\((?:[^\s()]|\([^\s()]*\))*\)/g, ']'));
}

/** Item count, every section present, no em dashes, under the word limit. Always on. */
export function formatCheck(digest: Digest, markdown: string): CheckResult {
  const problems = [...missingSections(digest)];
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
