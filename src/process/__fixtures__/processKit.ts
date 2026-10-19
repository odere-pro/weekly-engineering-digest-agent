// Shared by the tests in src/process: scored items, entries and the default thresholds.
import type { Classification, ScoredItem } from '../../classify/classification';
import { ThresholdsSchema } from '../../config/schema';
import type { Item } from '../../domain/schemas';
import { makeScoredItem } from '../../../test/builders';
import type { Entry } from '../types';

/** The thresholds a fresh config carries (`config/schema.ts` defaults). */
export const defaultThresholds = ThresholdsSchema.parse({});

/** A scored item with this id; `classification` and `item` override the builder defaults. */
export function scored(
  id: string,
  classification: Partial<Classification> = {},
  item: Partial<Item> = {},
): ScoredItem {
  return makeScoredItem({ id, ...item }, classification);
}

/** The same, from another source with this title: the shape of a story seen in two feeds. */
export function story(id: string, sourceId: string, title: string, relevance = 2.5): ScoredItem {
  return scored(id, { relevance }, { sourceId, title });
}

export const entryOf = (item: ScoredItem): Entry => ({ item });

export const entriesOf = (items: readonly ScoredItem[]): Entry[] => items.map(entryOf);

export const ids = (items: readonly ScoredItem[]): string[] => items.map((item) => item.id);

export const entryIds = (entries: readonly Entry[]): string[] =>
  entries.map((entry) => entry.item.id);
