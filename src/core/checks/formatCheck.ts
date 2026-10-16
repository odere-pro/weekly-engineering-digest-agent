import type { Digest } from '../schemas.js';
import { wordCount } from '../../shared/text.js';
import type { CheckResult } from './types.js';

const MIN_ITEMS = 3;
const MAX_ITEMS = 5;
const WORD_LIMIT = 500;
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

/** 3-5 items, every section present, no em dashes, under 500 words. Always on. */
export function formatCheck(digest: Digest, markdown: string): CheckResult {
  const problems = [...missingSections(digest)];
  const count = digest.items.length;
  if (count < MIN_ITEMS || count > MAX_ITEMS) {
    problems.unshift(`Expected 3-5 items, got ${count}`);
  }
  if (markdown.includes(EM_DASH)) problems.push('Contains an em dash');
  const words = readableWordCount(markdown);
  if (words >= WORD_LIMIT) problems.push(`Expected under ${WORD_LIMIT} words, got ${words}`);
  return { ok: problems.length === 0, problems };
}
