import type { ScoredItem } from '../classify/classification';

/** Why `processStep` left an item out. */
export type DropReason =
  'duplicate' | 'sent-before' | 'low-relevance' | 'hype' | 'minor-release' | 'below-top-n';

export interface Dropped {
  itemId: string;
  reason: DropReason;
}

/**
 * An input item. The wrapper gives every input position its own identity, so two items with
 * equal ids (or the same object passed twice) stay distinguishable.
 */
export interface Entry {
  readonly item: ScoredItem;
}
