import { ItemSchema, type Item } from '../../../src/domain/schemas';
import { itemIdFor } from '../../../src/shared/url';
import type { SourceRecording } from '../recordings/types';
import { isOutsideAllowlist } from './sourceAllowedHosts';
import type { SourceResult } from './types';

/** A summary shorter than this is as good as none for the classifier and the writer. */
export const MIN_SUMMARY_CHARS = 40;

/** True when the id is not the hash of the URL, or the URL cannot be hashed. */
export function hasWrongId(item: Item): boolean {
  try {
    return item.id !== itemIdFor(item.url);
  } catch {
    return true;
  }
}

const count = (items: readonly Item[], test: (item: Item) => boolean): number =>
  items.filter(test).length;

/** Counts the defects in the items a fetcher yielded from one recording. */
export function tally(source: SourceRecording, items: readonly Item[]): SourceResult {
  return {
    sourceId: source.source.id,
    parsed: items.length,
    expected: source.expected.items.length,
    schemaInvalid: count(items, (item) => !ItemSchema.safeParse(item).success),
    emptyTitle: count(items, (item) => item.title.trim() === ''),
    emptySummary: count(items, (item) => item.summary.trim().length < MIN_SUMMARY_CHARS),
    badDate: count(items, (item) => Number.isNaN(Date.parse(item.publishedAt))),
    idMismatch: count(items, hasWrongId),
    hostOutsideAllowlist: count(items, (item) => isOutsideAllowlist(item.url)),
  };
}
