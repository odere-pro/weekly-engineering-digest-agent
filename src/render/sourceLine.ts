import type { Item } from '../domain/schemas';
import { truncate } from '../shared/text';
import { SOURCE_TITLE_MAX_CHARS, safeSourceText } from './sourceText';

const NO_SUMMARY = 'No summary in the source.';
const ELLIPSIS = '...';
const EM_DASH = /(?:(?<!\s)\s+)?—+\s*/g;
const WORD = /[\p{L}\p{N}]/u;
/** A sentence ends at ., ! or ? followed by a space, so "1.0" and "v2.1.3" do not end one. */
const SENTENCE_END = /(?<=[.!?])\s+/;

/**
 * Plain text from a source: one line, no link-like token and no `href=` or `src=` attribute
 * (`safeSourceText`), no em dash (the format check rejects it), no pipe (a table cell separator).
 * Backslashes go first, so `href\\=` cannot hide an attribute. Pure.
 */
export function plain(text: string): string {
  return safeSourceText(text.replace(EM_DASH, ' - ').replaceAll('|', ' ').replaceAll('\\', ''));
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
    .replace(/(?<![.,;:!?])[.,;:!?]+$/, '')}${ELLIPSIS}`;
}

/** The item's own title as safe link text; a blank one shows the url. */
export function titleOf(item: Pick<Item, 'title' | 'url'>): string {
  return truncate(plain(item.title), SOURCE_TITLE_MAX_CHARS).trim() || item.url;
}
