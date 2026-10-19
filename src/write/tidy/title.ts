import type { DigestItem } from '../../domain/schemas';

/** Words that add nothing next to a version: "Release v1.2.0", "Version 1.2.0". */
const RELEASE_FILLER: ReadonlySet<string> = new Set(['release', 'released', 'version', 'tag', 'v']);

/** The item with its title collapsed when the title only restates its own release tag. */
export function tidyTitle(item: DigestItem): DigestItem {
  return { ...item, title: collapseRestatedTag(item.title) };
}

/**
 * "tool v1.2.0: Release v1.2.0" becomes "tool v1.2.0". A title tail after the first colon that
 * only repeats words from the head, plus filler like "Release", says nothing new.
 */
export function collapseRestatedTag(title: string): string {
  const colon = title.indexOf(':');
  const head = colon > 0 ? title.slice(0, colon).trim() : '';
  const tail = colon > 0 ? title.slice(colon + 1).trim() : '';
  if (head === '' || tail === '') return title;
  const known = new Set(comparableWords(head));
  const isNew = (word: string): boolean => !known.has(word) && !RELEASE_FILLER.has(word);
  return comparableWords(tail).some(isNew) ? title : head;
}

/** Lowercase words of a title, with a sentence-ending dot and a version's "v" prefix removed. */
export function comparableWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;:()[\]]+/)
    .map((word) => withoutTrailingDots(word).replace(/^v(?=\d)/, ''))
    .filter(Boolean);
}

/** A loop, not `/\.+$/`: that pattern is quadratic on a long run of dots inside model output. */
export function withoutTrailingDots(word: string): string {
  let end = word.length;
  while (end > 0 && word[end - 1] === '.') end -= 1;
  return word.slice(0, end);
}
